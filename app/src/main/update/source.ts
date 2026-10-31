let resolver: ((bundled: string) => string) | null = null
/** Main installs the verified store resolver before admitting user requests. */
export function configureSkillSource(resolve: (bundled: string) => string): void { resolver = resolve }
export function resolveSkillSource(bundled: string): string { return resolver ? resolver(bundled) : bundled }
