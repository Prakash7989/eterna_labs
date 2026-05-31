# Build stage
FROM rust:1.80-slim-bookworm as builder

# Install build dependencies
RUN apt-get update && apt-get install -y pkg-config libssl-dev

WORKDIR /usr/src/app

# Copy Cargo files
COPY Cargo.toml Cargo.lock ./

# Create a dummy project to cache dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release
RUN rm -rf src

# Copy actual source code
COPY src ./src
COPY db ./db

# Build the real application
# Touch the main.rs file so cargo knows it needs to be recompiled
RUN touch src/main.rs
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary from the builder environment
COPY --from=builder /usr/src/app/target/release/matchmaker /usr/local/bin/matchmaker

# The port your application will listen on (Railway uses PORT env var)
EXPOSE 8081

# Run the application
CMD ["matchmaker"]
