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
 * Markdownを見出し境界で分割する
 * 大きなセクションはsplitTextで再分割
 */
export function splitMarkdown(markdown: string): string[] {
  // 見出し（# ## ###）を境界として分割
  const sections = markdown.split(/(?=^#{1,3}\s)/m);
  const chunks: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // 500文字超のセクションはsplitTextで再分割
    if (trimmed.length > 500) {
      const subChunks = splitText(trimmed);
      chunks.push(...subChunks);
    } else {
      chunks.push(trimmed);
    }
  }

  return chunks;
}
