export type PetAssets = Record<string, { dir: string; states: string[]; skins: string[] }>;
export function readPetRegistry(root: string): PetAssets;
