#!/usr/bin/env npx tsx

import crypto from "crypto";

function computeConfigHash(config: Record<string, any>): string {
  const sortedKeys = Object.keys(config).sort();
  const sorted: Record<string, any> = {};
  for (const key of sortedKeys) {
    sorted[key] = config[key];
  }
  const json = JSON.stringify(sorted);
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 12);
}

function test(name: string, fn: () => boolean) {
  try {
    const result = fn();
    if (result) {
      console.log(`  PASS: ${name}`);
    } else {
      console.log(`  FAIL: ${name}`);
      process.exitCode = 1;
    }
  } catch (err: any) {
    console.log(`  FAIL: ${name} - ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("Canonical Hashing Stability Tests");
console.log("==================================\n");

test("Same object produces same hash", () => {
  const obj = { a: 1, b: 2, c: 3 };
  const hash1 = computeConfigHash(obj);
  const hash2 = computeConfigHash(obj);
  return hash1 === hash2;
});

test("Different key insertion order produces same hash", () => {
  const obj1 = { a: 1, b: 2, c: 3 };
  const obj2 = { c: 3, a: 1, b: 2 };
  const hash1 = computeConfigHash(obj1);
  const hash2 = computeConfigHash(obj2);
  return hash1 === hash2;
});

test("Nested objects - top-level keys are sorted", () => {
  const obj1 = { z: { y: 1, x: 2 }, a: 1 };
  const obj2 = { a: 1, z: { y: 1, x: 2 } };
  const hash1 = computeConfigHash(obj1);
  const hash2 = computeConfigHash(obj2);
  return hash1 === hash2;
});

test("Different values produce different hash", () => {
  const obj1 = { a: 1, b: 2 };
  const obj2 = { a: 1, b: 3 };
  const hash1 = computeConfigHash(obj1);
  const hash2 = computeConfigHash(obj2);
  return hash1 !== hash2;
});

test("Empty object produces consistent hash", () => {
  const hash1 = computeConfigHash({});
  const hash2 = computeConfigHash({});
  return hash1 === hash2 && hash1.length === 12;
});

test("Boolean values are handled correctly", () => {
  const obj1 = { enabled: true, disabled: false };
  const obj2 = { disabled: false, enabled: true };
  const hash1 = computeConfigHash(obj1);
  const hash2 = computeConfigHash(obj2);
  return hash1 === hash2;
});

test("Numeric edge cases", () => {
  const obj = { zero: 0, negative: -1, float: 0.5, large: 1000000 };
  const hash1 = computeConfigHash(obj);
  const hash2 = computeConfigHash({ large: 1000000, float: 0.5, negative: -1, zero: 0 });
  return hash1 === hash2;
});

test("String values are handled correctly", () => {
  const obj1 = { mode: "paper", profile: "low" };
  const obj2 = { profile: "low", mode: "paper" };
  return computeConfigHash(obj1) === computeConfigHash(obj2);
});

test("Hash is 12 characters", () => {
  const hash = computeConfigHash({ test: 123 });
  return hash.length === 12;
});

test("Hash is hexadecimal", () => {
  const hash = computeConfigHash({ test: "value" });
  return /^[0-9a-f]{12}$/.test(hash);
});

console.log("\n==================================");
console.log(process.exitCode ? "Some tests failed!" : "All tests passed!");
