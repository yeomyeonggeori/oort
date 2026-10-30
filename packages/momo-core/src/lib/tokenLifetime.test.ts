import {expect, it} from "vitest";
import {tokenExpiresAtMs} from "./tokenLifetime";

it("reads only a finite numeric JWT expiry; malformed/opaque tokens request a refresh", () => {
  // {"exp":1800000900}, {"exp":"1800000900"}, {"exp":null}
  expect(tokenExpiresAtMs("e30.eyJleHAiOjE4MDAwMDA5MDB9.signature")).toBe(1_800_000_900_000);
  expect(tokenExpiresAtMs("e30.eyJleHAiOiIxODAwMDAwOTAwIn0.signature")).toBeNull();
  expect(tokenExpiresAtMs("e30.eyJleHAiOm51bGx9.signature")).toBeNull();
  expect(tokenExpiresAtMs("e30.not-json.signature")).toBeNull();
  expect(tokenExpiresAtMs(null)).toBeNull();
});
