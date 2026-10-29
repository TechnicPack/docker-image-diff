FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

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
