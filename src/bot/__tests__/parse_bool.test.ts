import { describe, it, expect } from "vitest";
import { parseBool } from "../parse_bool.js";

describe("parseBool", () => {
  describe("boolean inputs", () => {
    it("returns true for boolean true", () => {
      expect(parseBool(true)).toBe(true);
    });

    it("returns false for boolean false", () => {
      expect(parseBool(false)).toBe(false);
    });
  });

  describe("number inputs", () => {
    it("returns true for non-zero numbers", () => {
      expect(parseBool(1)).toBe(true);
      expect(parseBool(42)).toBe(true);
      expect(parseBool(-1)).toBe(true);
    });

    it("returns false for zero", () => {
      expect(parseBool(0)).toBe(false);
    });
  });

  describe("string inputs - true values", () => {
    it("returns true for 'true'", () => {
      expect(parseBool("true")).toBe(true);
    });

    it("returns true for 'TRUE' (case insensitive)", () => {
      expect(parseBool("TRUE")).toBe(true);
    });

    it("returns true for 'True' (case insensitive)", () => {
      expect(parseBool("True")).toBe(true);
    });

    it("returns true for '1'", () => {
      expect(parseBool("1")).toBe(true);
    });

    it("returns true for 'yes'", () => {
      expect(parseBool("yes")).toBe(true);
    });

    it("returns true for 'y'", () => {
      expect(parseBool("y")).toBe(true);
    });

    it("returns true for 'on'", () => {
      expect(parseBool("on")).toBe(true);
    });

    it("handles whitespace", () => {
      expect(parseBool("  true  ")).toBe(true);
    });
  });

  describe("string inputs - false values", () => {
    it("returns false for 'false'", () => {
      expect(parseBool("false")).toBe(false);
    });

    it("returns false for 'FALSE' (case insensitive)", () => {
      expect(parseBool("FALSE")).toBe(false);
    });

    it("returns false for 'False' (case insensitive)", () => {
      expect(parseBool("False")).toBe(false);
    });

    it("returns false for '0'", () => {
      expect(parseBool("0")).toBe(false);
    });

    it("returns false for 'no'", () => {
      expect(parseBool("no")).toBe(false);
    });

    it("returns false for 'n'", () => {
      expect(parseBool("n")).toBe(false);
    });

    it("returns false for 'off'", () => {
      expect(parseBool("off")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(parseBool("")).toBe(false);
    });

    it("handles whitespace for false values", () => {
      expect(parseBool("  false  ")).toBe(false);
    });
  });

  describe("string inputs - unknown values default to false", () => {
    it("returns false for random string", () => {
      expect(parseBool("random")).toBe(false);
    });

    it("returns false for 'undefined' string", () => {
      expect(parseBool("undefined")).toBe(false);
    });

    it("returns false for 'null' string", () => {
      expect(parseBool("null")).toBe(false);
    });
  });

  describe("null/undefined inputs", () => {
    it("returns false for null", () => {
      expect(parseBool(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(parseBool(undefined)).toBe(false);
    });
  });

  describe("object inputs", () => {
    it("returns false for objects", () => {
      expect(parseBool({})).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(parseBool([])).toBe(false);
    });
  });
});
