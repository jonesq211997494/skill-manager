export type VersionCode = 'current' | 'available' | 'local-changed' | 'both-changed' | 'unknown-source' | 'unchecked' | 'check-failed' | 'stale' | 'pinned' | 'mixed' | 'incomplete';
export type VersionState = {status:VersionCode;label:string;description:string;checkedAt:string|null;canCheck:boolean;deploymentId?:string;tool?:string;scope?:string;tools?:string[];scopes?:string[]};
export type VersionSummary = VersionState & {states:VersionState[];checkedCount:number;totalCount:number};
export const VERSION_STATUS_TTL_MS:number;
export function buildVersionStates(skill:any,updates?:any[],options?:{now?:number}):VersionState[];
export function summarizeVersionStates(states?:VersionState[],options?:{pinned?:boolean;now?:number}):VersionSummary;
export function getSkillVersionStatus(skill:any,options?:{tool?:string;scope?:string;now?:number}):VersionSummary;
export function versionStateMatches(item:VersionState,filters?:{tool?:string;scope?:string}):boolean;

export function hasVersionSource(source:any):boolean;
