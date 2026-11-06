FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

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
