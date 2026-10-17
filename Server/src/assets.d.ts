declare module "*.yaml" {
  const source: string;
  export default source;
}

declare module "*/VERSION" {
  const source: string;
  export default source;
}
