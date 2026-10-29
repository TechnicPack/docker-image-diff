FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94

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
