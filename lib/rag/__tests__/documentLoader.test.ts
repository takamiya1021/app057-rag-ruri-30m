import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadDocument } from "../documentLoader";
import * as fs from "node:fs";
import * as path from "node:path";

const TMP_DIR = "/tmp/rag-test-docloader";

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("loadDocument", () => {
  it(".txt ファイルを読める", async () => {
    const filePath = path.join(TMP_DIR, "test.txt");
    fs.writeFileSync(filePath, "Hello World");
    const doc = await loadDocument(filePath);
    expect(doc.text).toBe("Hello World");
    expect(doc.format).toBe("txt");
    expect(doc.source).toBe("test.txt");
  });

  it(".md ファイルを読める", async () => {
    const filePath = path.join(TMP_DIR, "test.md");
    fs.writeFileSync(filePath, "# タイトル\n本文");
    const doc = await loadDocument(filePath);
    expect(doc.text).toBe("# タイトル\n本文");
    expect(doc.format).toBe("md");
  });

  it(".json ファイルを読める", async () => {
    const filePath = path.join(TMP_DIR, "test.json");
    fs.writeFileSync(filePath, JSON.stringify({ key: "value", nested: { a: 1 } }));
    const doc = await loadDocument(filePath);
    expect(doc.format).toBe("json");
    expect(doc.text).toContain("value");
  });

  it(".csv ファイルを読める", async () => {
    const filePath = path.join(TMP_DIR, "test.csv");
    fs.writeFileSync(filePath, "name,age\nAlice,30\nBob,25");
    const doc = await loadDocument(filePath);
    expect(doc.text).toBe("name,age\nAlice,30\nBob,25");
    expect(doc.format).toBe("csv");
    expect(doc.source).toBe("test.csv");
  });

  it(".csv 空ファイルでもエラーにならない", async () => {
    const filePath = path.join(TMP_DIR, "empty.csv");
    fs.writeFileSync(filePath, "");
    const doc = await loadDocument(filePath);
    expect(doc.text).toBe("");
    expect(doc.format).toBe("csv");
  });

  it("未対応拡張子はエラーを投げる", async () => {
    const filePath = path.join(TMP_DIR, "test.xyz");
    fs.writeFileSync(filePath, "data");
    await expect(loadDocument(filePath)).rejects.toThrow("Unsupported file format: .xyz");
  });
});
