declare module "virtual:pet-assets" {
  const assets: Record<string, { dir: string; states: string[]; skins: string[] }>;
  export default assets;
}
