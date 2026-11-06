FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

RUN apk add --no-cache ca-certificates docker-cli docker-cli-buildx

ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/TechnicPack/docker-image-diff" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

COPY dist/gitlab.cjs LICENSE /opt/docker-image-diff/

ENTRYPOINT ["node", "/opt/docker-image-diff/gitlab.cjs"]
CMD []
