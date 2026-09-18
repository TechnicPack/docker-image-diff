import { parseDocument } from 'yaml';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ALIAS_COUNT = 50;
const COMPOSE_FILE = /^(?:compose(?:\..+)?|docker-compose.*)\.ya?ml$/i;
const DOCKER_FILE = /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/i;

/** @param {string} path */
function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** @param {string} path @returns {boolean} */
export function isSupportedFile(path) {
  const name = basename(path);
  return COMPOSE_FILE.test(name) || DOCKER_FILE.test(name);
}

/**
 * Discover literal references only; no interpolation, Docker execution, or YAML
 * custom tag construction is performed. Registry validation happens downstream.
 * @param {string} path
 * @param {string} content
 * @returns {import('./types.js').Discovery}
 */
export function discoverImages(path, content) {
  if (!isSupportedFile(path)) {
    return {
      references: [],
      warnings: ['Unsupported image definition file.'],
      incomplete: true,
    };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_INPUT_BYTES) {
    return {
      references: [],
      warnings: ['Image definition exceeds the 1 MiB parsing limit.'],
      incomplete: true,
    };
  }
  return COMPOSE_FILE.test(basename(path))
    ? discoverCompose(content)
    : discoverDockerfile(content.replace(/^\uFEFF/, ''));
}

/** @param {string} content @returns {import('./types.js').Discovery} */
function discoverCompose(content) {
  const references = [];
  const warnings = [];
  const skippedKeys = [];
  let data;
  try {
    const document = parseDocument(content, {
      schema: 'core',
      merge: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
    // Unknown tags must not silently degrade to strings or other YAML types.
    if (document.errors.length || document.warnings.length) {
      return {
        references,
        warnings: [...document.errors, ...document.warnings].map(
          (error) => `Cannot parse Compose YAML: ${error.message}`,
        ),
        incomplete: true,
      };
    }
    data = document.toJS({ mapAsMap: true, maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    return {
      references,
      warnings: [`Cannot parse Compose YAML: ${error.message}`],
      incomplete: true,
    };
  }
  if (!(data instanceof Map)) {
    return {
      references,
      warnings: ['Compose YAML must contain a mapping.'],
      incomplete: true,
    };
  }
  const services = data.get('services');
  if (services === undefined) return { references, warnings };
  if (!(services instanceof Map)) {
    return {
      references,
      warnings: ['Compose services must contain a mapping.'],
      incomplete: true,
    };
  }
  for (const [name, service] of services) {
    if (typeof name !== 'string' || name.length === 0) {
      warnings.push('Compose service names must be nonempty strings.');
      return { references, warnings, incomplete: true };
    }
    if (!(service instanceof Map)) {
      warnings.push(`Compose service ${name} must contain a mapping.`);
      skippedKeys.push(`service:${name}`);
      continue;
    }
    if (!service.has('image')) continue;
    const image = service.get('image');
    if (typeof image !== 'string' || image.length === 0) {
      warnings.push(`Compose service ${name} image must be a nonempty string.`);
      skippedKeys.push(`service:${name}`);
    } else if (image.includes('$')) {
      warnings.push(
        `Compose service ${name} image contains unresolved variables; interpolation is not evaluated.`,
      );
      skippedKeys.push(`service:${name}`);
    } else {
      references.push({ key: `service:${name}`, image });
    }
  }
  return { references, warnings, skippedKeys };
}

/** @param {string} content @returns {import('./types.js').Discovery} */
function discoverDockerfile(content) {
  const references = [];
  const warnings = [];
  const skippedKeys = [];
  let incomplete = false;
  const aliases = new Set();
  const duplicateAliases = new Set();
  let stageIndex = 0;
  let instruction = '';
  let instructionLine = 0;
  let continuing = false;
  let directivesAllowed = true;
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (directivesAllowed) {
      const directive = /^\s*#\s*(syntax|escape|check)\s*=\s*(.*?)\s*$/i.exec(
        line,
      );
      if (directive) {
        if (directive[1].toLowerCase() === 'escape' && directive[2] !== '\\') {
          warnings.push(
            `Dockerfile line ${index + 1}: unsupported escape directive; references were not inspected.`,
          );
          return { references: [], warnings, incomplete: true };
        }
        continue;
      }
      directivesAllowed = false;
    }
    // Full-line comments and empty continuation lines are not instruction data.
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (!continuing) {
      instruction = '';
      instructionLine = index + 1;
    }
    continuing = /\\[\t ]*$/.test(line);
    instruction += continuing ? line.replace(/\\[\t ]*$/, '') : line;
    if (continuing) continue;

    const parsed = /^\s*([^\s]+)(?:\s+(.*))?$/.exec(instruction);
    if (!parsed) continue;
    const keyword = parsed[1].toUpperCase();
    if (keyword !== 'FROM') {
      // Without interpreting shell quoting and heredoc delimiters, payload lines
      // cannot safely be distinguished from Dockerfile instructions.
      if (
        ['RUN', 'COPY', 'ADD'].includes(keyword) &&
        instruction.includes('<<')
      ) {
        warnings.push(
          `Dockerfile line ${instructionLine}: heredoc syntax is not inspected; later stages were skipped.`,
        );
        incomplete = true;
        break;
      }
      continue;
    }

    const currentIndex = stageIndex++;
    const tokens = (parsed[2] ?? '').trim().split(/\s+/);
    let platform;
    if (tokens[0].startsWith('--platform=')) {
      platform = tokens.shift().slice('--platform='.length);
    }
    const image = tokens[0];
    const hasAlias = tokens.length === 3 && tokens[1].toUpperCase() === 'AS';
    const alias = hasAlias ? tokens[2].toLowerCase() : undefined;
    if (
      !image ||
      image.startsWith('--') ||
      platform === '' ||
      (tokens.length !== 1 && !hasAlias) ||
      (alias !== undefined && !/^[a-z][a-z0-9_.-]*$/.test(alias))
    ) {
      warnings.push(
        `Dockerfile line ${instructionLine}: malformed or unsupported FROM instruction.`,
      );
      incomplete = true;
      continue;
    }

    const isEarlierStage = aliases.has(image.toLowerCase());
    if (alias !== undefined) {
      if (aliases.has(alias)) {
        duplicateAliases.add(alias);
        warnings.push(
          `Dockerfile line ${instructionLine}: duplicate stage alias ${alias}; ambiguous references were skipped.`,
        );
      }
      aliases.add(alias);
    }
    if (platform?.includes('$')) {
      warnings.push(
        `Dockerfile line ${instructionLine}: --platform contains unresolved variables; the literal image is inspected without evaluating the platform.`,
      );
    }
    if (image.includes('$')) {
      warnings.push(
        `Dockerfile line ${instructionLine}: image contains unresolved variables; ARG and interpolation are not evaluated.`,
      );
      skippedKeys.push(`stage:${alias ?? currentIndex}`);
      continue;
    }
    if (image.toLowerCase() === 'scratch' || isEarlierStage) continue;
    if (alias !== undefined && duplicateAliases.has(alias)) continue;
    references.push({ key: `stage:${alias ?? currentIndex}`, image });
  }
  if (continuing) {
    warnings.push(
      `Dockerfile line ${instructionLine}: unterminated backslash continuation was skipped.`,
    );
    incomplete = true;
  }
  return {
    references: references.filter(
      (reference) =>
        !duplicateAliases.has(reference.key.slice('stage:'.length)),
    ),
    warnings,
    incomplete,
    skippedKeys: [
      ...skippedKeys,
      ...[...duplicateAliases].map((alias) => `stage:${alias}`),
    ],
  };
}
