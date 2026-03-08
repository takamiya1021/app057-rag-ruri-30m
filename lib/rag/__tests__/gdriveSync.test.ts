import { describe, it, expect } from "vitest";
import { isDownloadTarget, makeSafeName, addExtIfNeeded } from "../gdriveSync";

describe("isDownloadTarget（ホワイトリスト方式）", () => {
  // DL対象のmimeType
  it("Google Docs → DL対象", () => {
    expect(isDownloadTarget("application/vnd.google-apps.document")).toBe(true);
  });

  it("Google Sheets → DL対象", () => {
    expect(isDownloadTarget("application/vnd.google-apps.spreadsheet")).toBe(true);
  });

  it("Google Slides → DL対象", () => {
    expect(isDownloadTarget("application/vnd.google-apps.presentation")).toBe(true);
  });

  it("PDF → DL対象", () => {
    expect(isDownloadTarget("application/pdf")).toBe(true);
  });

  it("text/plain → DL対象", () => {
    expect(isDownloadTarget("text/plain")).toBe(true);
  });

  it("text/markdown → DL対象", () => {
    expect(isDownloadTarget("text/markdown")).toBe(true);
  });

  it("text/csv → DL対象", () => {
    expect(isDownloadTarget("text/csv")).toBe(true);
  });

  it("application/json → DL対象", () => {
    expect(isDownloadTarget("application/json")).toBe(true);
  });

  // DL対象外のmimeType（ホワイトリストにないものは全部false）
  it("画像 → DL対象外", () => {
    expect(isDownloadTarget("image/png")).toBe(false);
    expect(isDownloadTarget("image/jpeg")).toBe(false);
  });

  it("動画 → DL対象外", () => {
    expect(isDownloadTarget("video/mp4")).toBe(false);
    expect(isDownloadTarget("video/quicktime")).toBe(false);
  });

  it("音声 → DL対象外", () => {
    expect(isDownloadTarget("audio/mpeg")).toBe(false);
    expect(isDownloadTarget("audio/wav")).toBe(false);
  });

  it("Google Apps動画 → DL対象外", () => {
    expect(isDownloadTarget("application/vnd.google-apps.vid")).toBe(false);
  });

  it("Google Appsフォルダ → DL対象外", () => {
    expect(isDownloadTarget("application/vnd.google-apps.folder")).toBe(false);
  });

  it("Google Appsショートカット → DL対象外", () => {
    expect(isDownloadTarget("application/vnd.google-apps.shortcut")).toBe(false);
  });

  it("Google Appsフォーム → DL対象外", () => {
    expect(isDownloadTarget("application/vnd.google-apps.form")).toBe(false);
  });

  it("Google Apps図形 → DL対象外", () => {
    expect(isDownloadTarget("application/vnd.google-apps.drawing")).toBe(false);
  });

  it("Google Appsサイト → DL対象外", () => {
    expect(isDownloadTarget("application/vnd.google-apps.site")).toBe(false);
  });

  it("Google Appsマップ → DL対象外", () => {
    expect(isDownloadTarget("application/vnd.google-apps.map")).toBe(false);
  });

  it("未知のmimeType → DL対象外", () => {
    expect(isDownloadTarget("application/octet-stream")).toBe(false);
    expect(isDownloadTarget("application/zip")).toBe(false);
    expect(isDownloadTarget("application/vnd.google-apps.unknown")).toBe(false);
  });
});

describe("makeSafeName（ファイル名サニタイズ）", () => {
  it("シングルクォートをアンダースコアに置換する", () => {
    expect(makeSafeName("Osaka's Food")).toBe("Osaka_s Food");
  });

  it("ダブルクォートをアンダースコアに置換する", () => {
    expect(makeSafeName('She said "hello"')).toBe("She said _hello_");
  });

  it("スラッシュをアンダースコアに置換する", () => {
    expect(makeSafeName("path/to/file")).toBe("path_to_file");
  });

  it("バックスラッシュをアンダースコアに置換する", () => {
    expect(makeSafeName("path\\to\\file")).toBe("path_to_file");
  });

  it("複数の特殊文字が混在するファイル名", () => {
    expect(makeSafeName(`Osaka's "Street Food" Culture`)).toBe("Osaka_s _Street Food_ Culture");
  });

  it("実際のエラーファイル: Woman's Shocked Morning Reflection.", () => {
    expect(makeSafeName("Woman's Shocked Morning Reflection.")).toBe("Woman_s Shocked Morning Reflection.");
  });

  it("実際のエラーファイル: Shrine Visit to Kami's Realm", () => {
    expect(makeSafeName("Shrine Visit to Kami's Realm")).toBe("Shrine Visit to Kami_s Realm");
  });

  it("日本語ファイル名はそのまま通す", () => {
    expect(makeSafeName("テスト文書.txt")).toBe("テスト文書.txt");
  });

  it("特殊文字がないファイル名はそのまま通す", () => {
    expect(makeSafeName("normal-file_name.pdf")).toBe("normal-file_name.pdf");
  });

  it("空文字列はそのまま返す", () => {
    expect(makeSafeName("")).toBe("");
  });
});

describe("addExtIfNeeded（二重拡張子防止）", () => {
  it("拡張子がないファイル名に拡張子を付加する", () => {
    expect(addExtIfNeeded("document", ".pdf")).toBe("document.pdf");
  });

  it("同じ拡張子が既にあれば付加しない", () => {
    expect(addExtIfNeeded("④A均衡、波及、循環.pdf", ".pdf")).toBe("④A均衡、波及、循環.pdf");
  });

  it("大文字小文字を区別しない", () => {
    expect(addExtIfNeeded("report.PDF", ".pdf")).toBe("report.PDF");
  });

  it("異なる拡張子の場合は付加する", () => {
    expect(addExtIfNeeded("data.json", ".txt")).toBe("data.json.txt");
  });

  it("Google Apps形式（拡張子なし）のファイル名に拡張子を付加する", () => {
    expect(addExtIfNeeded("議事録メモ", ".txt")).toBe("議事録メモ.txt");
  });

  it(".txtファイル名に.txtを付加しない", () => {
    expect(addExtIfNeeded("readme.txt", ".txt")).toBe("readme.txt");
  });

  it(".csvファイル名に.csvを付加しない", () => {
    expect(addExtIfNeeded("data.csv", ".csv")).toBe("data.csv");
  });
});

describe("シェルコマンド安全性", () => {
  it("サニタイズ後のファイル名がシングルクォートを含まない", () => {
    const dangerous = [
      "Osaka's Food",
      "It's a test",
      "file'name.txt",
      "don't do this",
      "A'B'C'D",
    ];
    for (const name of dangerous) {
      const safe = makeSafeName(name);
      expect(safe).not.toContain("'");
    }
  });
});
