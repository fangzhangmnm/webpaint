import type { CloudProvider } from "./types.ts";
import type * as graphModule from "./providers/graph.ts";
type GraphTransport = typeof graphModule;
export declare function graphToCloudProvider(graph: GraphTransport): CloudProvider;
export {};
