// The parts of the Trusted Types API (https://w3c.github.io/trusted-types/dist/spec/) the end-to-end tests use; TypeScript's DOM types
// do not include it yet. The app's own code declares only what it needs, in src/security/script-url-policy.ts.

interface TrustedTypePolicyOptions {
  createHTML?: (input: string) => string;
  createScript?: (input: string) => string;
  createScriptURL?: (input: string) => string;
}

interface TrustedTypePolicy {
  createHTML(input: string): unknown;
  createScript(input: string): unknown;
  createScriptURL(input: string): unknown;
}

interface TrustedTypePolicyFactory {
  createPolicy(name: string, options?: TrustedTypePolicyOptions): TrustedTypePolicy;
}

declare var TrustedTypePolicyFactory: { prototype: TrustedTypePolicyFactory };
declare var trustedTypes: TrustedTypePolicyFactory;
