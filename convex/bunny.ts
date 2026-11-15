import { BunnyStorage } from "convex-bunny";

import { components } from "./_generated/api";

export const bunnyStorage = new BunnyStorage(components.bunny, {
  storageZone: process.env.BUNNY_STORAGE_ZONE ?? "test-zone",
  apiKey: process.env.BUNNY_API_KEY ?? "test-api-key",
  cdnHostname: process.env.BUNNY_CDN_HOSTNAME ?? "test.b-cdn.net",
  region: process.env.BUNNY_REGION ?? "default",
});

export function getBunnyArtifactCdnUrl(key: string) {
  return bunnyStorage.getCdnUrl(key);
}

export function getBunnyStorageZone() {
  return process.env.BUNNY_STORAGE_ZONE ?? "test-zone";
}

export function getBunnyStorageApiKey() {
  return process.env.BUNNY_API_KEY ?? "test-api-key";
}

export function getBunnyStorageRegion() {
  return process.env.BUNNY_REGION ?? "default";
}

export function getBunnyStorageHostname(region = getBunnyStorageRegion()) {
  return {
    default: "storage.bunnycdn.com",
    de: "storage.bunnycdn.com",
    ny: "ny.storage.bunnycdn.com",
    la: "la.storage.bunnycdn.com",
    sg: "sg.storage.bunnycdn.com",
    syd: "syd.storage.bunnycdn.com",
    br: "br.storage.bunnycdn.com",
    jh: "jh.storage.bunnycdn.com",
  }[region] ?? "storage.bunnycdn.com";
}

export function getBunnyArtifactStorageUrl(key: string) {
  return `https://${getBunnyStorageHostname()}/${getBunnyStorageZone()}/${key}`;
}
