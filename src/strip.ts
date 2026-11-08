import { sha256 } from "./canonical.ts";

export const RULE_DUPLICATE_HEADER_BLOCK = "duplicate-header-block"; // Catches byte-identical marked header blocks repeated consecutively.
export const HEADER_BLOCK_START = "<!-- ROOM HEADER START -->"; // Marks the start of the only header-block form eligible for duplicate removal.
export const HEADER_BLOCK_END = "<!-- ROOM HEADER END -->"; // Marks the end of the only header-block form eligible for duplicate removal.
export const RULE_TRAILING_TOOL_LOG_TAIL = "trailing-tool-log-tail"; // Catches timestamped tool-call and tool-result framing only at the end of a paste.
export const TIMESTAMPED_TOOL_LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z (?:tool-call|tool-result): \S.*$/; // Catches ISO-8601 UTC tool-call/result framing lines.
export const RULE_DUPLICATE_STATUS_BLOCK = "duplicate-status-block"; // Catches identical, adjacent status blocks repeated at the end of a paste.
export const STATUS_BLOCK_START = "--- ROOM STATUS ---"; // Marks the start of the only status-block form eligible for duplicate removal.
export const STATUS_BLOCK_END = "--- END ROOM STATUS ---"; // Marks the end of the only status-block form eligible for duplicate removal.
export const CHARS_PER_TOKEN_ESTIMATE = 4; // ESTIMATE: one fixed chars/4 token-count heuristic; it is not measured tokenization.
export const ASSUMED_USD_PER_MILLION_TOKENS = 5; // ASSUMPTION: illustrative single-rate cost of $5 per million estimated tokens.

export type StripRuleSet = "wrapper" | "filler" | "both";

export interface StripReceipt {
  originalSha256: string;
  strippedSha256: string;
  originalBytes: number;
  strippedBytes: number;
  linesRemoved: number;
  rulesApplied: string[];
  ruleSet: StripRuleSet;
  linesBefore: number;
  linesAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedCostMicroDollarsBefore: number;
  estimatedCostMicroDollarsAfter: number;
}

export interface StripResult {
  text: string;
  receipt: StripReceipt;
}

interface PreservedLine {
  body: string;
  ending: string;
  raw: string;
}

interface TextRange {
  start: number;
  end: number;
}

interface WrapperResult {
  text: string;
  linesRemoved: number;
  rulesApplied: string[];
}

interface FillerResult {
  text: string;
  linesRemoved: number;
  rulesApplied: string[];
}

function splitLinesPreservingEndings(text: string): PreservedLine[] {
  const lines: PreservedLine[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
    let ending = "";
    if (end < text.length) {
      ending = text[end] === "\r" && text[end + 1] === "\n" ? "\r\n" : text[end]!;
    }
    const next = end + ending.length;
    lines.push({ body: text.slice(start, end), ending, raw: text.slice(start, next) });
    start = next;
  }
  return lines;
}

export function countTextLines(text: string): number {
  return splitLinesPreservingEndings(text).length;
}

function headerBlockEnd(lines: PreservedLine[], start: number): number | undefined {
  if (lines[start]?.body !== HEADER_BLOCK_START) return undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.body === HEADER_BLOCK_START) return undefined;
    if (lines[index]!.body === HEADER_BLOCK_END) return index;
  }
  return undefined;
}

function rawLines(lines: PreservedLine[], start: number, endExclusive: number): string {
  return lines.slice(start, endExclusive).map((line) => line.raw).join("");
}

function removeDuplicateHeaderBlocks(lines: PreservedLine[], rules: Set<string>): number {
  let linesRemoved = 0;
  let index = 0;
  while (index < lines.length) {
    const firstEnd = headerBlockEnd(lines, index);
    if (firstEnd === undefined) {
      index += 1;
      continue;
    }
    const firstLength = firstEnd - index + 1;
    const firstRaw = rawLines(lines, index, firstEnd + 1);
    const nextStart = index + firstLength;
    while (nextStart < lines.length) {
      const nextEnd = headerBlockEnd(lines, nextStart);
      if (nextEnd === undefined || nextEnd - nextStart + 1 !== firstLength || rawLines(lines, nextStart, nextEnd + 1) !== firstRaw) break;
      lines.splice(nextStart, firstLength);
      linesRemoved += firstLength;
      rules.add(RULE_DUPLICATE_HEADER_BLOCK);
    }
    index = nextStart;
  }
  return linesRemoved;
}

function statusBlockStartingAt(lines: PreservedLine[], start: number): number | undefined {
  if (lines[start]?.body !== STATUS_BLOCK_START) return undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.body === STATUS_BLOCK_START) return undefined;
    if (lines[index]!.body === STATUS_BLOCK_END) return index;
  }
  return undefined;
}

function statusBlockEndingAt(lines: PreservedLine[], endExclusive: number): number | undefined {
  if (endExclusive < 2 || lines[endExclusive - 1]?.body !== STATUS_BLOCK_END) return undefined;
  for (let index = endExclusive - 2; index >= 0; index -= 1) {
    if (lines[index]!.body === STATUS_BLOCK_START) return statusBlockStartingAt(lines, index) === endExclusive - 1 ? index : undefined;
    if (lines[index]!.body === STATUS_BLOCK_END) return undefined;
  }
  return undefined;
}

function removeTrailingLogTail(lines: PreservedLine[], rules: Set<string>): number {
  let linesRemoved = 0;
  while (lines.length > 0) {
    const last = lines.at(-1)!;
    if (TIMESTAMPED_TOOL_LOG_LINE.test(last.body)) {
      lines.pop();
      linesRemoved += 1;
      rules.add(RULE_TRAILING_TOOL_LOG_TAIL);
      continue;
    }
    const lastStatusStart = statusBlockEndingAt(lines, lines.length);
    if (lastStatusStart === undefined) break;
    const priorStatusStart = statusBlockEndingAt(lines, lastStatusStart);
    if (priorStatusStart === undefined || rawLines(lines, priorStatusStart, lastStatusStart) !== rawLines(lines, lastStatusStart, lines.length)) break;
    const removedStatusLines = lines.length - lastStatusStart;
    lines.splice(lastStatusStart);
    linesRemoved += removedStatusLines;
    rules.add(RULE_DUPLICATE_STATUS_BLOCK);
  }
  return linesRemoved;
}

function stripWrapperPaste(text: string): WrapperResult {
  const rules = new Set<string>();
  const lines = splitLinesPreservingEndings(text);
  const linesRemoved = removeDuplicateHeaderBlocks(lines, rules) + removeTrailingLogTail(lines, rules);
  return { text: rawLines(lines, 0, lines.length), linesRemoved, rulesApplied: [...rules] };
}

function rangeContains(ranges: TextRange[], index: number): TextRange | undefined {
  return ranges.find((range) => range.start <= index && index < range.end);
}

function rangeOverlaps(ranges: TextRange[], start: number, end: number): boolean {
  return ranges.some((range) => range.start < end && start < range.end);
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) merged.push({ ...range });
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

function fencedCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter((match) => match[0].length > 0);
  let opening: { start: number; marker: string; length: number } | undefined;
  let offset = 0;
  for (const lineMatch of lines) {
    const raw = lineMatch[0];
    const line = raw.replace(/(?:\r\n|\n|\r)$/, "");
    if (!opening) {
      const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
      if (match) opening = { start: offset, marker: match[1]![0]!, length: match[1]!.length };
    } else {
      const markerPattern = opening.marker === "`" ? /^[ \t]{0,3}`{3,}[ \t]*$/ : /^[ \t]{0,3}~{3,}[ \t]*$/;
      const marker = line.match(opening.marker === "`" ? /`+/ : /~+/)?.[0];
      if (markerPattern.test(line) && marker && marker.length >= opening.length) {
        ranges.push({ start: opening.start, end: offset + raw.length });
        opening = undefined;
      }
    }
    offset += raw.length;
  }
  if (opening) ranges.push({ start: opening.start, end: text.length });
  return ranges;
}

function inlineCodeRanges(text: string, protectedRanges: TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < text.length) {
    if (rangeContains(protectedRanges, index) || text[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (text[runEnd] === "`") runEnd += 1;
    const runLength = runEnd - index;
    let cursor = runEnd;
    let closingStart = -1;
    while (cursor < text.length) {
      const protectedRange = rangeContains(protectedRanges, cursor);
      if (protectedRange) {
        cursor = protectedRange.end;
        continue;
      }
      if (text[cursor] === "`") {
        let candidateEnd = cursor + 1;
        while (text[candidateEnd] === "`") candidateEnd += 1;
        if (candidateEnd - cursor === runLength) {
          closingStart = cursor;
          break;
        }
        cursor = candidateEnd;
      } else cursor += 1;
    }
    if (closingStart >= 0) {
      const closeEnd = closingStart + runLength;
      ranges.push({ start: index, end: closeEnd });
      index = closeEnd;
    } else index = runEnd;
  }
  return ranges;
}

function quotedRanges(text: string, protectedRanges: TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < text.length) {
    if (rangeContains(protectedRanges, index) || (text[index] !== "\"" && text[index] !== "'")) {
      index += 1;
      continue;
    }
    const quote = text[index]!;
    if (quote === "'" && /[\p{L}\p{N}_]/u.test(text[index - 1] ?? "") && /[\p{L}\p{N}_]/u.test(text[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    let close = -1;
    while (cursor < text.length) {
      const protectedRange = rangeContains(protectedRanges, cursor);
      if (protectedRange) {
        cursor = protectedRange.end;
        continue;
      }
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === quote && (quote !== "'" || !/[\p{L}\p{N}_]/u.test(text[cursor + 1] ?? ""))) {
        close = cursor;
        break;
      }
      cursor += 1;
    }
    if (close >= 0) {
      ranges.push({ start: index, end: close + 1 });
      index = close + 1;
    } else index += 1;
  }
  return ranges;
}

function jsonRanges(text: string, protectedRanges: TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if ((text[start] !== "{" && text[start] !== "[") || rangeContains(protectedRanges, start)) continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      if (!inString) {
        const protectedRange = rangeContains(protectedRanges, index);
        if (protectedRange) {
          index = protectedRange.end - 1;
          continue;
        }
      }
      const character = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") inString = true;
      else if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const opener = stack.pop();
        if ((character === "}" && opener !== "{") || (character === "]" && opener !== "[")) break;
        if (stack.length === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end > start) {
      try {
        JSON.parse(text.slice(start, end));
        ranges.push({ start, end });
        start = end - 1;
      } catch {
        continue;
      }
    }
  }
  return ranges;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function protectedRanges(text: string): TextRange[] {
  const fenced = fencedCodeRanges(text);
  const inline = inlineCodeRanges(text, fenced);
  const code = mergeRanges([...fenced, ...inline]);
  const json = jsonRanges(text, code);
  const quoted = quotedRanges(text, mergeRanges([...code, ...json]));
  const ranges: TextRange[] = [...code, ...json, ...quoted];
  const patterns = [
    /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+/giu,
    /(?:^|(?<=[\s(]))(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])[^\s<>"'`]+/gu,
    /\b[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.[\p{L}\p{N}]{1,12}\b/gu,
    /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (!rangeOverlaps(ranges, start, end)) ranges.push({ start, end });
    }
  }
  return mergeRanges(ranges);
}

function applyMatches(
  text: string,
  pattern: RegExp,
  rule: string,
  marker: string,
  rules: Set<string>,
  replacement: (match: RegExpMatchArray) => string = () => marker,
): string {
  const ranges = protectedRanges(text);
  const matches = [...text.matchAll(pattern)];
  let output = text;
  for (const match of matches.reverse()) {
    const start = match.index!;
    const end = start + match[0].length;
    if (rangeOverlaps(ranges, start, end)) continue;
    const next = replacement(match);
    if (next === match[0]) continue;
    output = `${output.slice(0, start)}${next}${output.slice(end)}`;
    rules.add(rule);
  }
  return output;
}

function chooseMarker(text: string): string {
  for (let code = 0xe000; code <= 0xf8ff; code += 1) {
    const marker = String.fromCharCode(code);
    if (!text.includes(marker)) return marker;
  }
  throw new Error("Text contains no available filler-strip marker");
}

function alternatives(phrases: string[]): string {
  return phrases
    .sort((left, right) => right.length - left.length)
    .map((phrase) => escapeRegExp(phrase).replace(/\\ /g, "[ \\t]+"))
    .join("|");
}

function applyFillerRules(text: string): FillerResult {
  const rules = new Set<string>();
  const marker = chooseMarker(text);
  let current = text;
  current = applyMatches(current, /^[ \t]*please(?:,[ \t]*|(?=[ \t]|$))/gi, "F1", marker, rules);
  current = applyMatches(
    current,
    /(?<![\p{L}\p{N}_])[ \t]*(?:thank you so much|thanks so much|thank you|thanks)(?:[!.])?[ \t]*(?:\r\n?|\n)*$/giu,
    "F1",
    marker,
    rules,
  );

  const requestFrames = alternatives([
    "could you please",
    "can you please",
    "would you please",
    "will you please",
    "would you mind",
    "could you",
    "can you",
    "would you",
    "will you",
    "kindly",
    "please",
  ]);
  const requestPattern = new RegExp(
    `(^[ \\t]*(?:${escapeRegExp(marker)}[ \\t]*)*|[.!?][ \\t]+|\\r?\\n[ \\t]*)(?:${requestFrames})(?![\\p{L}\\p{N}_])(?:,[ \\t]*|[ \\t]+|(?=[.!?;:]|$))`,
    "gimu",
  );
  const stripRequestFrames = () => {
    while (true) {
      const next = applyMatches(current, requestPattern, "F2", marker, rules, (match) => `${match[1] ?? ""}${marker}`);
      if (next === current) break;
      current = next;
    }
  };
  stripRequestFrames();

  const softeners = alternatives([
    "if you don't mind",
    "when you get a chance",
    "whenever you get a chance",
    "if you have a moment",
    "I was wondering if you could",
    "I would appreciate it if you could",
    "it would be great if you could",
    "I'd like you to",
    "I would like you to",
  ]);
  const softenerPattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${softeners})(?![\\p{L}\\p{N}_])(?:,[ \\t]*|[ \\t]+|(?=[.!?;:]|$))`,
    "giu",
  );
  current = applyMatches(current, softenerPattern, "F3", marker, rules);

  const padding = alternatives(["as a matter of fact", "basically", "essentially"]);
  const paddingPattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${padding})(?![\\p{L}\\p{N}_])(?:,[ \\t]*|[ \\t]+|(?=[.!?;:]|$))`,
    "giu",
  );
  current = applyMatches(current, paddingPattern, "F4", marker, rules);

  const orderTo = /(?<![\p{L}\p{N}_])in[ \t]+order[ \t]+(to)(?![\p{L}\p{N}_])/giu;
  current = applyMatches(current, orderTo, "F4", marker, rules, (match) => match[1]!);
  stripRequestFrames();

  if (rules.size > 0) current = repairText(current, marker);
  const linesRemoved = Math.max(0, countTextLines(text) - countTextLines(current));
  const ruleOrder = ["F1", "F2", "F3", "F4"];
  return { text: current, linesRemoved, rulesApplied: ruleOrder.filter((rule) => rules.has(rule)) };
}

function dropMarkedEmptySentences(text: string, marker: string): string {
  const ranges = protectedRanges(text);
  let output = "";
  let sentenceStart = 0;
  let index = 0;
  while (index < text.length) {
    const protectedRange = rangeContains(ranges, index);
    if (protectedRange) {
      index = protectedRange.end;
      continue;
    }
    const character = text[index]!;
    let boundaryEnd = -1;
    if (character === "\r" || character === "\n") {
      boundaryEnd = character === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
    } else if (".!?".includes(character) && (index + 1 === text.length || /\s/u.test(text[index + 1]!))) {
      boundaryEnd = index + 1;
    }
    if (boundaryEnd >= 0) {
      const segment = text.slice(sentenceStart, boundaryEnd);
      const emptyAfterRemoval = segment.includes(marker) && !/[\p{L}\p{N}]/u.test(segment);
      if (!emptyAfterRemoval) output += segment;
      else {
        while (boundaryEnd < text.length && /\s/u.test(text[boundaryEnd]!)) boundaryEnd += 1;
      }
      sentenceStart = boundaryEnd;
      index = boundaryEnd;
    } else index += 1;
  }
  const finalSegment = text.slice(sentenceStart);
  if (!finalSegment.includes(marker) || /[\p{L}\p{N}]/u.test(finalSegment)) output += finalSegment;
  return output.replaceAll(marker, "");
}

function mapUnprotected(text: string, transform: (chunk: string) => string): string {
  const ranges = protectedRanges(text);
  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    output += transform(text.slice(cursor, range.start));
    output += text.slice(range.start, range.end);
    cursor = range.end;
  }
  output += transform(text.slice(cursor));
  return output;
}

function repairText(text: string, marker: string): string {
  let current = dropMarkedEmptySentences(text, marker);
  current = mapUnprotected(current, (chunk) => chunk
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+(?=\r\n|\r|\n)/g, "")
    .replace(/ +([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])[ \t]*([.,!?;:])+/g, "$1"));

  let ranges = protectedRanges(current);
  while (current.length > 0 && /\s/u.test(current[0]!) && !rangeContains(ranges, 0)) {
    current = current.slice(1);
    ranges = protectedRanges(current);
  }
  while (current.length > 0 && /\s/u.test(current.at(-1)!) && !rangeContains(ranges, current.length - 1)) {
    current = current.slice(0, -1);
    ranges = protectedRanges(current);
  }
  const lastNonSpace = current.length - 1;
  if (lastNonSpace >= 0 && current[lastNonSpace] === "," && !rangeContains(ranges, lastNonSpace)
    && /^\s*$/u.test(current.slice(lastNonSpace + 1))) {
    current = `${current.slice(0, lastNonSpace)}${current.slice(lastNonSpace + 1)}`;
  }
  return current;
}

export function stripPaste(text: string): StripResult {
  const wrapper = stripWrapperPaste(text);
  const filler = applyFillerRules(wrapper.text);
  const rulesApplied = [...wrapper.rulesApplied, ...filler.rulesApplied];
  const wrapperFired = wrapper.rulesApplied.length > 0;
  const fillerFired = filler.rulesApplied.length > 0;
  const ruleSet: StripRuleSet = wrapperFired && fillerFired ? "both" : fillerFired ? "filler" : "wrapper";
  const tokensBefore = estimateTokensEstimate(text);
  const tokensAfter = estimateTokensEstimate(filler.text);
  const receipt: StripReceipt = {
    originalSha256: sha256(Buffer.from(text, "utf8")),
    strippedSha256: sha256(Buffer.from(filler.text, "utf8")),
    originalBytes: Buffer.byteLength(text, "utf8"),
    strippedBytes: Buffer.byteLength(filler.text, "utf8"),
    linesRemoved: wrapper.linesRemoved + filler.linesRemoved,
    rulesApplied,
    ruleSet,
    linesBefore: countTextLines(text),
    linesAfter: countTextLines(filler.text),
    estimatedTokensBefore: tokensBefore,
    estimatedTokensAfter: tokensAfter,
    estimatedCostMicroDollarsBefore: estimateCostMicroDollars(tokensBefore),
    estimatedCostMicroDollarsAfter: estimateCostMicroDollars(tokensAfter),
  };
  return { text: filler.text, receipt };
}

export function estimateTokensEstimate(text: string): number {
  return Math.ceil(Array.from(text).length / CHARS_PER_TOKEN_ESTIMATE);
}

export function estimateCostMicroDollars(estimatedTokens: number): number {
  return estimatedTokens * ASSUMED_USD_PER_MILLION_TOKENS;
}
