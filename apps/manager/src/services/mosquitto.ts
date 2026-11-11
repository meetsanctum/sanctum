import { pbkdf2Sync, randomBytes } from "node:crypto";

import type { ServiceSpec } from "./containers.js";
import { stacked } from "../stack.js";

// The MQTT broker. It has no port on the host: only containers on the
// `sanctum` network reach it, so it needs no TLS certificate. Every client has
// its own account, which the manager generates, and may use only its own
// topics.

export const mosquittoImage = "eclipse-mosquitto:2.1.2-alpine";
export const mosquittoUrl = `mqtt://${stacked("sanctum-mosquitto")}:1883`;
const dataVolume = stacked("sanctum-mosquitto-data");

export type MqttClient = {
  username: string;
  // The password hash, never the password: the broker only checks it.
  hash: string;
  // MQTT topic filters the client may read and write, such as zigbee2mqtt/#.
  topics: string[];
};

// A password-file entry in Mosquitto's own format (sha512-pbkdf2, as
// `mosquitto_passwd -H sha512-pbkdf2` writes it).
export function mosquittoPasswordHash(password: string) {
  const iterations = 1000;
  const salt = randomBytes(64);
  const hash = pbkdf2Sync(password, salt, iterations, 64, "sha512");
  return `$7$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const config = [
  "listener 1883",
  "allow_anonymous false",
  "password_file /mosquitto/config/passwd",
  "acl_file /mosquitto/config/acl",
  "persistence true",
  "persistence_location /mosquitto/data/",
  "log_dest stdout",
  "",
].join("\n");

// The files arrive as environment variables and are written before the
// broker starts, so a change of clients replaces the container and nothing
// on the host keeps an old account. Mosquitto 2.1 reads the password and ACL
// files only when they belong to its user.
const script = [
  "set -eu",
  "umask 077",
  'printf "%s" "$SANCTUM_MOSQUITTO_CONFIG" | base64 -d > /mosquitto/config/sanctum.conf',
  'printf "%s" "$SANCTUM_MOSQUITTO_PASSWORDS" | base64 -d > /mosquitto/config/passwd',
  'printf "%s" "$SANCTUM_MOSQUITTO_ACL" | base64 -d > /mosquitto/config/acl',
  "chown mosquitto:mosquitto /mosquitto/config/passwd /mosquitto/config/acl",
  "exec mosquitto -c /mosquitto/config/sanctum.conf",
].join("\n");

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

export function mosquittoSpec(clients: MqttClient[]): ServiceSpec {
  const passwords = clients
    .map((client) => `${client.username}:${client.hash}\n`)
    .join("");
  const acl = clients
    .map(
      (client) =>
        `user ${client.username}\n${client.topics
          .map((topic) => `topic readwrite ${topic}\n`)
          .join("")}`,
    )
    .join("\n");
  return {
    image: mosquittoImage,
    env: [
      `SANCTUM_MOSQUITTO_CONFIG=${base64(config)}`,
      `SANCTUM_MOSQUITTO_PASSWORDS=${base64(passwords)}`,
      `SANCTUM_MOSQUITTO_ACL=${base64(acl)}`,
    ],
    cmd: ["sh", "-c", script],
    volumes: [{ name: dataVolume, target: "/mosquitto/data" }],
  };
}
