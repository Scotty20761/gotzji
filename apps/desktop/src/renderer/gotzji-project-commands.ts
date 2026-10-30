export interface ProjectCommandOption {
  readonly recipeId: string;
  readonly title: string;
  readonly ownerOnly: boolean;
}

/** Only the selected project's already-reviewed immutable recipe IDs are choices. */
export function projectCommandOptions(boundIds: readonly string[], catalog: readonly Readonly<Record<string, unknown>>[]): readonly ProjectCommandOption[] {
  return catalog.flatMap((entry) => {
    if (typeof entry.recipeId !== 'string' || entry.name !== `command.recipe.${entry.recipeId}` || entry.state !== 'available' || !boundIds.includes(entry.recipeId)) return [];
    const title = typeof entry.description === 'string' && entry.description.trim() ? entry.description : entry.recipeId;
    return [{ recipeId: entry.recipeId, title: title.replace(/ \(delivery: the owner runs it from the gotzji app\)$/u, ''), ownerOnly: entry.controller === 'owner' }];
  });
}
