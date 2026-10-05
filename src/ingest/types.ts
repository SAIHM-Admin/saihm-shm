export type Namespace =
  | "policy"
  | "operational"
  | "learning"
  | "strategy"
  | "comms"
  | "reference"
  | "feedback"
  | "derived"
  | "generic"
  | "unknown";

export const STANDING_GUIDANCE_NAMESPACES: readonly Namespace[] = ["policy", "learning", "feedback"];

export interface SupersessionEdge {
  readonly kind: "cellId" | "name" | "cellIdPrefix" | "cellIdStem";
  readonly target: string;
  readonly viaPrefix?: string;
  readonly viaStem?: string;
}

export interface ParsedLabel {
  readonly tag: string;
  readonly namespace: Namespace;
  readonly salienceFloor: boolean;
  readonly decayExempt: boolean;
  readonly quarantined: boolean;
  readonly validTimeAdvisoryIso?: string;
  readonly links: readonly string[];
  readonly supersedes: readonly SupersessionEdge[];
  readonly supersededHint: boolean;
  readonly supersedesPrefixCandidates: readonly string[];
}

export interface MemoryRecord extends ParsedLabel {
  readonly cellId: string;
  readonly tenantId: string;
  readonly label: string;
  readonly ingestEpoch: number;
  readonly forgotten: boolean;
  readonly sourceHash: string;
}

export interface IngestStats {
  readonly total: number;
  readonly quarantined: number;
  readonly forgotten: number;
  readonly withSupersession: number;
  readonly withSupersededHint: number;
  readonly withSupersessionViaPrefix: number;
  readonly prefixAmbiguous: number;
  readonly prefixUnresolved: number;
  readonly withSupersessionViaStem: number;
  readonly stemAmbiguous: number;
  readonly cellIdUnresolved: number;
  readonly byNamespace: Readonly<Record<Namespace, number>>;
}

export interface IngestResult {
  readonly records: readonly MemoryRecord[];
  readonly stats: IngestStats;
}
