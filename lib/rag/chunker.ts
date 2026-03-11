// テキストチャンク分割（app056-rag-ruriから流用）

/**
 * 長い段落を句点・改行で分割し、chunkSize以内に収める
 * 句点（。）> 改行（\n）> 文字数の順で分割を試みる
 */
function splitLongParagraph(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > chunkSize) {
    // chunkSize以内で最後の句点を探す
    let splitPos = remaining.lastIndexOf("。", chunkSize);
    if (splitPos > 0) {
      splitPos += 1; // 句点を含める
    } else {
      // 句点がなければ改行で切る
      splitPos = remaining.lastIndexOf("\n", chunkSize);
      if (splitPos <= 0) {
        // 改行もなければ文字数で強制分割
        splitPos = chunkSize;
      }
    }

    chunks.push(remaining.slice(0, splitPos).trim());
    remaining = remaining.slice(splitPos).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * テキストを段落ベースでチャンク分割する
 * オーバーラップ付きで前後のチャンク間の文脈を維持
 * 長すぎる段落は句点・改行で再分割してトークン制限を回避
 */
export function splitText(
  text: string,
  chunkSize: number = 500,
  overlap: number = 50
): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // 段落自体がchunkSizeを超える場合は先に分割
    const subParts = splitLongParagraph(trimmed, chunkSize);

    for (const part of subParts) {
      const candidate = current ? current + "\n\n" + part : part;
      if (candidate.length <= chunkSize) {
        current = candidate;
      } else {
        if (current) {
          chunks.push(current);
        }
        current = part;
      }
    }
  }

  // 最後のチャンクを追加
  if (current) {
    chunks.push(current);
  }

  if (chunks.length === 0) return [];

  // 末尾断片の結合: 最後のチャンクがchunkSizeの50%未満なら直前に結合
  const tailThreshold = Math.floor(chunkSize * 0.5);
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < tailThreshold) {
    const tail = chunks.pop()!;
    chunks[chunks.length - 1] += "\n\n" + tail;
  }

  // オーバーラップ適用: 前チャンクの末尾overlap文字を次チャンクの先頭に含める
  if (overlap > 0 && chunks.length > 1) {
    const overlapped: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const prevChunk = chunks[i - 1];
      const overlapText = prevChunk.slice(-overlap);
      overlapped.push(overlapText + chunks[i]);
    }
    return overlapped;
  }

  return chunks;
}

/**
 * CSVを行グループで分割する
 * 各チャンクにヘッダ行を付与して、チャンク単体で列名がわかるようにする
 */
export function splitCSV(
  text: string,
  chunkSize: number = 500,
): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length <= 1) return lines[0]?.trim() ? [lines[0].trim()] : [];

  const header = lines[0];
  const dataLines = lines.slice(1).filter((l) => l.trim());
  if (dataLines.length === 0) return [header];

  const chunks: string[] = [];
  let current = header;

  for (const line of dataLines) {
    const candidate = current + "\n" + line;
    if (candidate.length > chunkSize && current !== header) {
      chunks.push(current);
      current = header + "\n" + line;
    } else {
      current = candidate;
    }
  }
  if (current && current !== header) {
    chunks.push(current);
  }

  // 末尾断片の結合（ヘッダ重複を除去してマージ）
  const tailThreshold = Math.floor(chunkSize * 0.5);
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < tailThreshold) {
    const tail = chunks.pop()!;
    const tailWithoutHeader = tail.startsWith(header + "\n")
      ? tail.slice(header.length + 1)
      : tail;
    chunks[chunks.length - 1] += "\n" + tailWithoutHeader;
  }

  return chunks;
}

/**
 * ソースコードを関数・クラス定義の境界で分割する
 * 定義境界が見つからない場合はsplitTextにフォールバック
 */
export function splitCode(
  text: string,
  chunkSize: number = 500,
  overlap: number = 50,
): string[] {
  // 関数・クラス定義の開始行を検出する正規表現
  // Python: def, class（インデント0のもの）
  // JS/TS: function, class, export function/class, const/let/var x = (async) () =>
  const boundary =
    /^(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s|class\s)|def\s+\w+|class\s+\w+|(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\()/m;

  const lines = text.split("\n");
  const blocks: string[] = [];
  let current = "";

  for (const line of lines) {
    // 境界行かつバッファにコードがあれば、ブロックを区切る
    if (boundary.test(line) && current.trim()) {
      blocks.push(current.trimEnd());
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) blocks.push(current.trimEnd());

  // 境界が見つからなかった場合はsplitTextにフォールバック
  if (blocks.length <= 1) {
    return splitText(text, chunkSize, overlap);
  }

  // 短いブロックは結合、長いブロックは再分割
  const chunks: string[] = [];
  let buffer = "";
  for (const block of blocks) {
    const candidate = buffer ? buffer + "\n\n" + block : block;
    if (candidate.length <= chunkSize) {
      buffer = candidate;
    } else {
      if (buffer) chunks.push(buffer);
      if (block.length > chunkSize) {
        // 長すぎるブロックはsplitTextで再分割（オーバーラップなし）
        chunks.push(...splitText(block, chunkSize, 0));
        buffer = "";
      } else {
        buffer = block;
      }
    }
  }
  if (buffer) chunks.push(buffer);

  // 末尾断片の結合
  const tailThreshold = Math.floor(chunkSize * 0.5);
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < tailThreshold) {
    const tail = chunks.pop()!;
    chunks[chunks.length - 1] += "\n\n" + tail;
  }

  return chunks;
}

/**
 * データ型に応じた適切なチャンク分割を行う統一エントリポイント
 *
 * | format | 分割単位               |
 * |--------|------------------------|
 * | md     | 見出し → 段落          |
 * | csv    | 行グループ（ヘッダ付） |
 * | code   | 関数・クラス定義境界   |
 * | txt等  | 段落 → 句点 → 固定長   |
 */
export function chunkDocument(
  text: string,
  format: string,
): string[] {
  switch (format) {
    case "md":
      return splitMarkdown(text);
    case "csv":
      return splitCSV(text);
    case "code":
      return splitCode(text);
    default:
      // txt, pdf, json, その他はすべて段落ベースの汎用分割
      return splitText(text);
  }
}

// 短すぎるチャンクの最小文字数（50→200に引き上げ: 薄いチャンク問題の対策）
const MIN_CHUNK_SIZE = 200;

/**
 * Markdownを見出し境界で分割する
 * 大きなセクションはsplitTextで再分割
 * 短すぎるセクション（50文字未満）は次のセクションに結合する
 */
export function splitMarkdown(markdown: string): string[] {
  // 見出し（# ## ###）を境界として分割
  const sections = markdown.split(/(?=^#{1,3}\s)/m);

  // 短すぎるセクションを次のセクションに結合する
  const merged: string[] = [];
  let buffer = "";
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (buffer) {
      buffer = buffer + "\n\n" + trimmed;
    } else {
      buffer = trimmed;
    }

    // バッファが最小サイズを超えたら確定
    if (buffer.length >= MIN_CHUNK_SIZE) {
      merged.push(buffer);
      buffer = "";
    }
  }
  // 残りがあれば最後のセクションに結合、なければ単独で追加
  if (buffer) {
    if (merged.length > 0) {
      merged[merged.length - 1] += "\n\n" + buffer;
    } else {
      merged.push(buffer);
    }
  }

  // 大きなセクションはsplitTextで再分割
  const chunks: string[] = [];
  for (const section of merged) {
    if (section.length > 500) {
      const subChunks = splitText(section);
      chunks.push(...subChunks);
    } else {
      chunks.push(section);
    }
  }

  return chunks;
}
