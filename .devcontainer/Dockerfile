FROM mcr.microsoft.com/devcontainers/javascript-node:dev-20

# Install PostgreSQL and the Neon CLI
RUN apt-get update
RUN apt-get -y install postgresql postgresql-contrib
RUN npm install -g neonctl
