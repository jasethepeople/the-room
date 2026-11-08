import type { KeyObject } from "node:crypto";

export type Hex = string;
export type Hash = Hex;
export type Base64Url = string;
export type Fingerprint = Hex;
export type EventId = string;
export type RoomId = string;
export type ThreadId = string;
export type Iso8601 = string;

export const ZERO_HASH: Hash = "0".repeat(64);

export interface CanonRule {
  id: string;
  minCosigns: number;
}

export interface ThreadDecl {
  id: ThreadId;
  title: string;
}

export interface MemberSpec {
  name: string;
  role: "human" | "harness-agent";
  modelId: string;
  publicKey: Base64Url;
  fingerprint: Fingerprint;
  subscriptions: ThreadId[];
  budgetTokens: number;
  tools: string[];
}

export interface GenesisRegistry {
  roomId: RoomId;
  roomName: string;
  createdAt: Iso8601;
  templateId: string;
  templateVersion: string;
  canonRule: CanonRule;
  threads: ThreadDecl[];
  members: MemberSpec[];
}

export type EvidenceRef =
  | { type: "event"; id: EventId }
  | { type: "external"; url: string; sha256: Hash; note?: string };

export interface SystemBody {
  kind: "system";
  genesisSha256: Hash;
  templateId: string;
  templateVersion: string;
}

export interface MembershipBody {
  kind: "membership";
  action: "join" | "leave";
  member: MemberSpec;
}

export interface TurnBody {
  kind: "turn";
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  artifact?: { path: string; sha256: Hash; bytes: number };
}

export interface ChallengeBody {
  kind: "challenge";
  targetEventId: EventId;
  claim: string;
  grounds: "factual" | "procedural" | "doctrinal";
  evidence: EvidenceRef[];
}

export interface VerdictBody {
  kind: "verdict";
  challengeId: EventId;
  outcome: "upheld" | "refuted" | "unproven";
  evidence: EvidenceRef[];
  rationale: string;
}

export interface ProposalBody {
  kind: "proposal";
  statement: string;
  appliesTo: "room" | { thread: ThreadId };
  supersedes?: EventId;
}

export interface CosignBody {
  kind: "cosign";
  proposalId: EventId;
  stance: "support" | "oppose";
}

export interface CanonBody {
  kind: "canon";
  action: "enact" | "demote";
  proposalId: EventId;
  cosigns: EventId[];
  reason: string;
  newRule?: CanonRule;
}

export interface BudgetBody {
  kind: "budget";
  member: Fingerprint;
  thread?: ThreadId;
  state: "paused" | "resumed";
  reason: "exhausted" | "human" | "rule";
  consumedTokens: number;
}

export interface SeamBody {
  kind: "seam";
  note: string;
  spans: { fromEventId: EventId; toEventId: EventId }[];
}

export interface SealBody {
  kind: "seal";
  chainHead: Hash;
  eventCount: number;
  seamsSha256: Hash;
}

export type EventBody =
  | SystemBody
  | MembershipBody
  | TurnBody
  | ChallengeBody
  | VerdictBody
  | ProposalBody
  | CosignBody
  | CanonBody
  | BudgetBody
  | SeamBody
  | SealBody;

export interface SignedEvent {
  id: EventId;
  roomId: RoomId;
  seq: number;
  threadId: ThreadId | null;
  author: Fingerprint;
  createdAt: Iso8601;
  body: EventBody;
  prevHash: Hash;
  hash: Hash;
  signature: Base64Url;
}

export interface RoomTemplate {
  id: string;
  version: string;
  canonRule: CanonRule;
  threads: ThreadDecl[];
  memberSlots: Array<{
    name: string;
    role: "human" | "harness-agent";
    modelId?: string;
    subscriptions: ThreadId[];
    budgetTokens: number;
    tools: string[];
  }>;
  headerSeed: string;
}

export interface Identity {
  fingerprint: Fingerprint;
  publicKey: Base64Url;
  privateKey: KeyObject;
  privateKeyPath: string;
}

export interface RoomPaths {
  home: string;
  rooms: string;
  room: string;
  genesis: string;
  transcript: string;
  transcriptMd: string;
  header: string;
  seams: string;
  lock: string;
  quarantine: string;
  keys: string;
  snapshot: (seq: number) => string;
}

export interface VerificationFailure {
  seq?: number;
  id?: EventId;
  reason: string;
}

export interface VerificationResult {
  ok: boolean;
  events: number;
  seals?: number;
  warnings: string[];
  firstFailure?: VerificationFailure;
}

export interface AppendContext {
  genesis: GenesisRegistry;
  priorEvents: SignedEvent[];
  events: SignedEvent[];
  seq: number;
  prevHash: Hash;
  seamsText: string;
  seamsBytes: Buffer;
  paths: RoomPaths;
}

export type EventBodyFactory = (context: AppendContext) => EventBody | Promise<EventBody>;

export interface AppendEntry {
  identity: Identity;
  threadId: ThreadId | null;
  body: EventBody | EventBodyFactory;
}

export interface FileMutation {
  path: string;
  content: string | Buffer;
  exclusive?: boolean;
}

export interface AppendBuildResult {
  entries: AppendEntry[];
  files?: FileMutation[];
  allowLatestSealRefresh?: boolean;
}

export interface RoomTemplateMember {
  name: string;
  role: "human" | "harness-agent";
  modelId?: string;
  subscriptions: ThreadId[];
  budgetTokens: number;
  tools: string[];
}

export interface RoomSpawnResult {
  roomId: RoomId;
  roomDir: string;
  genesis: GenesisRegistry;
  members: MemberSpec[];
}

export interface RoomMemberState {
  member: MemberSpec;
  present: boolean;
  consumedTokens: number;
  paused: boolean;
}
