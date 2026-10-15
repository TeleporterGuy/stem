# Small static image for the Stem relay.
#   docker build -t stem-relay relay/
#   docker run -v $PWD/relay-data:/data -p 8080:8080 stem-relay
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /stem-relay ./cmd/stem-relay

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /stem-relay /stem-relay
WORKDIR /data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/stem-relay"]
CMD ["serve", "-config", "/data/relay.toml"]
