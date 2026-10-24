export interface MutationApprovalWindowSize {
  readonly width: number;
  readonly height: number;
}

export function mutationApprovalWindowSize(workAreaSize: { readonly width: number; readonly height: number }): MutationApprovalWindowSize {
  return {
    width: Math.max(1, Math.min(760, workAreaSize.width)),
    height: Math.max(1, Math.min(680, workAreaSize.height)),
  };
}
