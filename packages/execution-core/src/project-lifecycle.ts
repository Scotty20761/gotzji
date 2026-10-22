import type { DatabaseSync } from 'node:sqlite';
import { CoreError, type ManagedProject, type RegisteredProject } from './types.js';

export interface ProjectLifecycleSnapshot {
  readonly project: RegisteredProject;
  readonly registration: string;
  readonly archivedAt: string | null;
  readonly generation: number;
}

function decode(row: Record<string, unknown> | undefined): ProjectLifecycleSnapshot | undefined {
  if (!row) return undefined;
  const registration = String(row.registration);
  return {
    project: JSON.parse(registration) as RegisteredProject,
    registration,
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
    generation: row.generation === null || row.generation === undefined ? 0 : Number(row.generation),
  };
}

export function projectLifecycle(database: DatabaseSync, owner: string, projectId: string): ProjectLifecycleSnapshot | undefined {
  return decode(database.prepare(`
    SELECT p.registration,l.archived_at,l.generation
    FROM gotzji_projects p
    LEFT JOIN gotzji_project_lifecycle l ON l.owner=p.owner AND l.project_id=p.project_id
    WHERE p.owner=? AND p.project_id=?
  `).get(owner, projectId));
}

export function activeProjectLifecycle(database: DatabaseSync, owner: string, projectId: string): ProjectLifecycleSnapshot {
  const lifecycle = projectLifecycle(database, owner, projectId);
  if (!lifecycle) throw new CoreError('PROJECT_NOT_REGISTERED', 'Select a project enrolled by this owner', 'projectId');
  if (lifecycle.archivedAt !== null) throw new CoreError('PROJECT_ARCHIVED', 'Restore this project in the gotzji app before using it', 'projectId');
  return lifecycle;
}

export function listManagedProjectRows(database: DatabaseSync, owner: string): readonly ManagedProject[] {
  return database.prepare(`
    SELECT p.registration,l.archived_at
    FROM gotzji_projects p
    LEFT JOIN gotzji_project_lifecycle l ON l.owner=p.owner AND l.project_id=p.project_id
    WHERE p.owner=? ORDER BY p.project_id
  `).all(owner).map((row) => ({
    ...(JSON.parse(String(row.registration)) as RegisteredProject),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
  }));
}

export function assertProjectLifecycleCurrent(database: DatabaseSync, owner: string, expected: ProjectLifecycleSnapshot): void {
  const current = projectLifecycle(database, owner, expected.project.projectId);
  if (!current || current.registration !== expected.registration || current.generation !== expected.generation || current.archivedAt !== null) throw new CoreError('PROJECT_LIFECYCLE_CHANGED');
}
