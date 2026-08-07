import { BackgroundSyncJobs } from "./background-sync-jobs.ts";
export declare function initTileJobs(): {
    jobs: BackgroundSyncJobs;
    dispose: () => void;
};
