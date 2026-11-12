FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

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
