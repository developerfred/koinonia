import type { Ms } from "./types.js";

export type Platform = "youtube_shorts" | "tiktok" | "instagram_reels";
export type Visibility = "private" | "unlisted" | "public";

/** Provenance of each documented fact. "documented" = seen in the official docs during research (2026-10); "assumed" = not verified, re-check before relying on it. */
export type Confidence = "documented" | "assumed";

export interface Requirement {
  note: string;
  confidence: Confidence;
  source?: string;
}

export interface HttpStep {
  method: "GET" | "POST" | "PUT";
  url: string;
  purpose: string;
  confidence: Confidence;
}

export interface PlatformSpec {
  platform: Platform;
  auth: Requirement[];
  limits: Requirement[];
  mediaRules: Requirement[];
  flow: HttpStep[];
}

export interface PublishAsset {
  /** Local/daemon ref to the rendered 9:16 file. */
  fileRef: string;
  /** Publicly fetchable URL (needed by Instagram, optional TikTok PULL_FROM_URL). */
  publicUrl?: string;
  durationMs: Ms;
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

export interface PublishMeta {
  title: string;
  description: string;
  hashtags: string[];
  visibility: Visibility;
}

export interface PublishIssue {
  severity: "error" | "warning";
  message: string;
}

export interface PublishCredentials {
  accessToken: string;
  /** IG user id, TikTok open_id, YouTube channel id... */
  accountId?: string;
}

export interface PublishResult {
  platform: Platform;
  remoteId: string;
  url?: string;
  status: "processing" | "published";
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is a documented stub; implement it behind PublishAdapter.publish`);
    this.name = "NotImplementedError";
  }
}

export interface PublishAdapter {
  readonly platform: Platform;
  readonly spec: PlatformSpec;
  validate(asset: PublishAsset, meta: PublishMeta): PublishIssue[];
  /** Never call directly: go through Publisher so the approval gate is enforced. */
  publish(asset: PublishAsset, meta: PublishMeta, creds: PublishCredentials): Promise<PublishResult>;
}

const DOC_YT = "https://developers.google.com/youtube/v3/docs/videos/insert";
const DOC_TT = "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post";
const DOC_IG = "https://developers.facebook.com/docs/instagram-platform/content-publishing";

function common(asset: PublishAsset, maxMs: Ms, label: string): PublishIssue[] {
  const out: PublishIssue[] = [];
  if (asset.width * 16 !== asset.height * 9) out.push({ severity: "warning", message: `${label}: asset is not 9:16` });
  if (asset.durationMs > maxMs) out.push({ severity: "error", message: `${label}: duration ${asset.durationMs}ms exceeds ${maxMs}ms (assumed limit)` });
  return out;
}

export class YouTubeShortsAdapter implements PublishAdapter {
  readonly platform = "youtube_shorts" as const;
  readonly spec: PlatformSpec = {
    platform: "youtube_shorts",
    auth: [
      { note: "OAuth 2.0 with scope https://www.googleapis.com/auth/youtube.upload", confidence: "documented", source: DOC_YT },
      { note: "Videos uploaded by API projects created after 2020-07-28 that have not passed a compliance audit are locked to private until audited", confidence: "documented", source: DOC_YT },
    ],
    limits: [
      { note: "Daily quota default 10,000 units; videos.insert cost is 100 units on the current reference, third-party guides say 1,600. Check the Cloud Console quota page", confidence: "documented", source: DOC_YT },
      { note: "Shorts max length 3 minutes for square/vertical video", confidence: "assumed" },
    ],
    mediaRules: [
      { note: "No separate Shorts endpoint: a vertical/square video within the length limit uploaded through videos.insert is classified as a Short by YouTube", confidence: "assumed" },
      { note: "Including #Shorts in title/description is optional", confidence: "assumed" },
    ],
    flow: [
      { method: "POST", url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", purpose: "start resumable upload session (snippet.title/description, status.privacyStatus)", confidence: "documented" },
      { method: "PUT", url: "<Location header of previous response>", purpose: "upload bytes (chunked, resumable)", confidence: "assumed" },
    ],
  };
  validate(asset: PublishAsset, meta: PublishMeta): PublishIssue[] {
    const out = common(asset, 180_000, "YouTube Shorts");
    if (meta.title.length > 100) out.push({ severity: "error", message: "YouTube title max 100 chars (assumed)" });
    if (meta.visibility === "public") out.push({ severity: "warning", message: "unaudited API projects are forced private (documented)" });
    return out;
  }
  async publish(): Promise<PublishResult> {
    throw new NotImplementedError("YouTubeShortsAdapter.publish");
  }
}

export class TikTokAdapter implements PublishAdapter {
  readonly platform = "tiktok" as const;
  readonly spec: PlatformSpec = {
    platform: "tiktok",
    auth: [
      { note: "OAuth via Login Kit with scope video.publish (Direct Post); video.upload for inbox/draft flow", confidence: "assumed" },
      { note: "Unaudited clients: all posts forced to private viewing; error unaudited_client_can_only_post_to_private_accounts (403) when the target account is not private; max 5 users per 24h per client", confidence: "documented", source: DOC_TT },
      { note: "An audit of the API client is required to lift the private restriction; duration of audit not documented", confidence: "documented", source: DOC_TT },
    ],
    limits: [{ note: "Query creator info before posting to obtain allowed privacy levels, max duration and interaction toggles; respect them", confidence: "assumed" }],
    mediaRules: [
      { note: "Source either FILE_UPLOAD (chunked) or PULL_FROM_URL (domain must be verified)", confidence: "assumed" },
      { note: "Content sharing guidelines require showing the user what will be posted and getting explicit consent: the approval gate here supports this", confidence: "assumed", source: "https://developers.tiktok.com/doc/content-sharing-guidelines" },
    ],
    flow: [
      { method: "POST", url: "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", purpose: "fetch creator posting options", confidence: "assumed" },
      { method: "POST", url: "https://open.tiktokapis.com/v2/post/publish/video/init/", purpose: "init direct post (post_info.title, privacy_level, source_info)", confidence: "documented" },
      { method: "PUT", url: "<upload_url from init response>", purpose: "upload chunks (FILE_UPLOAD)", confidence: "assumed" },
      { method: "POST", url: "https://open.tiktokapis.com/v2/post/publish/status/fetch/", purpose: "poll publish_id status", confidence: "assumed" },
    ],
  };
  validate(asset: PublishAsset, meta: PublishMeta): PublishIssue[] {
    const out = common(asset, 600_000, "TikTok");
    if (meta.title.length > 2200) out.push({ severity: "error", message: "TikTok caption too long (assumed 2200)" });
    if (meta.visibility !== "private") out.push({ severity: "warning", message: "unaudited clients are forced to private (documented)" });
    return out;
  }
  async publish(): Promise<PublishResult> {
    throw new NotImplementedError("TikTokAdapter.publish");
  }
}

export class InstagramReelsAdapter implements PublishAdapter {
  readonly platform = "instagram_reels" as const;
  readonly spec: PlatformSpec = {
    platform: "instagram_reels",
    auth: [
      { note: "Instagram professional (Business/Creator) account; permission instagram_content_publish (Facebook Login) or instagram_business_content_publish (Instagram Login); app review for production", confidence: "assumed", source: DOC_IG },
    ],
    limits: [{ note: "API-published posts limited per rolling 24h (100 on current docs, 50 on older pages); check GET /<IG_ID>/content_publishing_limit", confidence: "documented", source: DOC_IG }],
    mediaRules: [
      { note: "Reels use a container: video must be reachable at a public URL that Meta's servers fetch (video_url)", confidence: "documented", source: DOC_IG },
      { note: "Reels 9:16, roughly 5-90s (some guides) and H.264/HEVC MP4/MOV", confidence: "assumed" },
    ],
    flow: [
      { method: "POST", url: "https://graph.facebook.com/<ver>/<ig-user-id>/media", purpose: "create container: media_type=REELS, video_url, caption", confidence: "documented" },
      { method: "GET", url: "https://graph.facebook.com/<ver>/<container-id>?fields=status_code", purpose: "poll until FINISHED", confidence: "assumed" },
      { method: "POST", url: "https://graph.facebook.com/<ver>/<ig-user-id>/media_publish", purpose: "publish container (creation_id)", confidence: "documented" },
    ],
  };
  validate(asset: PublishAsset, meta: PublishMeta): PublishIssue[] {
    const out = common(asset, 90_000, "Instagram Reels");
    if (!asset.publicUrl) out.push({ severity: "error", message: "Instagram requires a public video URL (documented)" });
    if (meta.hashtags.length > 30) out.push({ severity: "error", message: "Instagram allows at most 30 hashtags (assumed)" });
    return out;
  }
  async publish(): Promise<PublishResult> {
    throw new NotImplementedError("InstagramReelsAdapter.publish");
  }
}

export function defaultAdapters(): PublishAdapter[] {
  return [new YouTubeShortsAdapter(), new TikTokAdapter(), new InstagramReelsAdapter()];
}

// ------------------------------------------------------------------ approval gate

export type ApprovalStatus = "pending" | "approved" | "rejected" | "published" | "failed";

export interface PublishRequest {
  id: string;
  platform: Platform;
  asset: PublishAsset;
  meta: PublishMeta;
  status: ApprovalStatus;
  /** Fingerprint of what was shown to the human; approval is void if content changes. */
  fingerprint: string;
  createdAtMs: number;
  approvedBy?: string;
  approvedAtMs?: number;
  result?: PublishResult;
  error?: string;
}

export class ApprovalError extends Error {}

export interface PublisherDeps {
  adapters: PublishAdapter[];
  /** Resolve credentials only at publish time. */
  credentials: (platform: Platform) => Promise<PublishCredentials>;
  now?: () => number;
  /** Approvals older than this are rejected at publish time. */
  approvalTtlMs?: Ms;
  idGen?: () => string;
}

export function fingerprint(platform: Platform, asset: PublishAsset, meta: PublishMeta): string {
  const s = JSON.stringify([platform, asset.fileRef, asset.publicUrl, asset.durationMs, asset.bytes, meta]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Human-in-the-loop publisher: submit -> approve (by a person) -> publish. There is no way to publish without approval. */
export class Publisher {
  private reqs = new Map<string, PublishRequest>();
  private seq = 0;
  constructor(private deps: PublisherDeps) {}
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private adapter(p: Platform) {
    const a = this.deps.adapters.find((x) => x.platform === p);
    if (!a) throw new Error(`no adapter for ${p}`);
    return a;
  }
  submit(platform: Platform, asset: PublishAsset, meta: PublishMeta): { request: PublishRequest; issues: PublishIssue[] } {
    const issues = this.adapter(platform).validate(asset, meta);
    const request: PublishRequest = { id: this.deps.idGen?.() ?? `pub${++this.seq}`, platform, asset, meta, status: "pending", fingerprint: fingerprint(platform, asset, meta), createdAtMs: this.now() };
    this.reqs.set(request.id, request);
    return { request, issues };
  }
  get(id: string) {
    return this.reqs.get(id);
  }
  list() {
    return [...this.reqs.values()];
  }
  /** Must be called from a human-initiated UI action. `seenFingerprint` is what the UI displayed. */
  approve(id: string, approver: string, seenFingerprint: string): PublishRequest {
    const r = this.must(id);
    if (!approver.trim()) throw new ApprovalError("approver required");
    if (r.status !== "pending") throw new ApprovalError(`cannot approve a ${r.status} request`);
    if (r.fingerprint !== seenFingerprint) throw new ApprovalError("content changed since it was shown; re-review");
    if (this.adapter(r.platform).validate(r.asset, r.meta).some((i) => i.severity === "error")) throw new ApprovalError("request has blocking validation errors");
    r.status = "approved";
    r.approvedBy = approver;
    r.approvedAtMs = this.now();
    return r;
  }
  reject(id: string): PublishRequest {
    const r = this.must(id);
    if (r.status !== "pending" && r.status !== "approved") throw new ApprovalError(`cannot reject a ${r.status} request`);
    r.status = "rejected";
    return r;
  }
  async publish(id: string): Promise<PublishRequest> {
    const r = this.must(id);
    if (r.status !== "approved") throw new ApprovalError(`request is ${r.status}, not approved`);
    if (r.fingerprint !== fingerprint(r.platform, r.asset, r.meta)) throw new ApprovalError("content changed after approval");
    if (this.now() - (r.approvedAtMs ?? 0) > (this.deps.approvalTtlMs ?? 3_600_000)) {
      r.status = "pending";
      throw new ApprovalError("approval expired; re-approve");
    }
    try {
      r.result = await this.adapter(r.platform).publish(r.asset, r.meta, await this.deps.credentials(r.platform));
      r.status = "published";
    } catch (e) {
      r.status = "failed";
      r.error = e instanceof Error ? e.message : String(e);
    }
    return r;
  }
  private must(id: string) {
    const r = this.reqs.get(id);
    if (!r) throw new Error(`unknown request ${id}`);
    return r;
  }
}
