export interface SdkMethod {
  path: string
  namespace: string
  method: string
  kind: 'read' | 'write'
  returns: string
}

export interface ToolLike {
  name: string
  sdkPath: string
  kind: 'read' | 'prepare'
}

export interface SurfaceDiff {
  missing: SdkMethod[]
  miscovered: (SdkMethod & { tool: string; expected: string; actual: string })[]
  covered: (SdkMethod & { tool: string })[]
  dangling: string[]
  staleExclusions: string[]
}

export declare function sdkDeclarationPath(): string
export declare function readSdkSurface(declarationPath?: string): SdkMethod[]
export declare function diffSurface(
  surface: SdkMethod[],
  tools: readonly ToolLike[],
  excluded: Record<string, string>,
): SurfaceDiff
