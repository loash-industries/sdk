export interface SdkParam {
  name: string
  optional: boolean
}

export interface SdkMethod {
  path: string
  namespace: string
  method: string
  kind: 'read' | 'write'
  returns: string
  /** Property names the method accepts, across every parameter. */
  params: SdkParam[]
}

export interface ToolLike {
  name: string
  sdkPath: string
  kind: 'read' | 'prepare'
  /** Zod shape; its keys are the tool's declared inputs. */
  inputShape?: Record<string, unknown>
  /** Explicit key list, for tests that do not build a zod shape. */
  inputKeys?: readonly string[]
  syntheticParams?: Record<string, string>
  derivedParams?: Record<string, string>
}

export interface ParamDiff {
  /** Tool inputs the SDK method does not accept and no waiver covers. */
  unknown: {
    tool: string
    sdkPath: string
    param: string
    accepted: string[]
  }[]
  /** Required SDK parameters neither accepted nor declared as derived. */
  missingRequired: { tool: string; sdkPath: string; param: string }[]
  /** Waivers that no longer describe reality. */
  stale: { tool: string; param: string; why: string }[]
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
export declare function diffParams(
  surface: SdkMethod[],
  tools: readonly ToolLike[],
  globalSynthetic?: Record<string, string>,
): ParamDiff
