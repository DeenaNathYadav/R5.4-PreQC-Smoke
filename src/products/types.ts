import { env as readEnv } from '../config/env';

/** Any Playwright selector string: CSS, `text=Dashboard`, `role=heading[name="Home"]`, etc. */
export type Selector = string;

export interface SmokePage {
  name: string;
  /** Path relative to the product base URL. */
  path: string;
  /** Element that proves the page rendered. */
  expect?: Selector;
  /** Expected document title (string = exact, RegExp = pattern). */
  title?: string | RegExp;
}

export interface FormLogin {
  type: 'form';
  username: Selector;
  password: Selector;
  submit: Selector;
  /** For two-step logins (username -> Next -> password). */
  next?: Selector;
}

/**
 * Microsoft Entra ID (Azure AD) SSO. Logs in automatically when USER/PASSWORD are set
 * (needs an account without MFA); otherwise reuses the session saved by `npm run login:cdp`.
 */
export interface AzureAdLogin {
  type: 'azure-ad';
}

export interface ProductConfig {
  /** Lower-case id: the env-var prefix (PI_URL), the Playwright project name and the `tests/<key>/` folder. */
  key: string;
  name: string;
  baseUrl: string;
  /** Page to open after login and in the "app loads" check. */
  homePath: string;
  username: string;
  password: string;
  /** null = the app has no login screen. */
  login: FormLogin | AzureAdLogin | null;
  /** Visible only once logged in (e.g. user menu, logout button). */
  loggedInIndicator: Selector;
  /** Element showing the deployed build/version, checked against EXPECTED_BUILD. */
  buildVersion?: Selector;
  pages: SmokePage[];
  /** Run in the signed-in Edge profile from `npm run login:cdp` (`<KEY>_USE_EDGE_PROFILE=1`) instead of the saved session. */
  useEdgeProfile: boolean;
  /** Most parallel workers the runner gives this product. A product that owns the Edge profile can only run one at a time. */
  maxWorkers?: number;
  /** Product-scoped env var: `pi.env('QUOTE_URL')` reads PI_QUOTE_URL ('' when unset). */
  env(name: string): string;
}

export type ProductOverrides = Partial<
  Omit<ProductConfig, 'key' | 'name' | 'baseUrl' | 'username' | 'password' | 'useEdgeProfile' | 'env'>
>;

const defaultFormLogin: FormLogin = {
  type: 'form',
  username: 'input[name="username"], input[type="email"], #username',
  password: 'input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"]',
};

/** Builds one product's config from its env vars (`<KEY>_URL`, `<KEY>_USER`, `<KEY>_PASSWORD`, …) plus overrides. */
export function defineProduct(key: string, name: string, overrides: ProductOverrides = {}): ProductConfig {
  const prefix = key.toUpperCase();
  const productEnv = (suffix: string) => readEnv(`${prefix}_${suffix}`);
  const useEdgeProfile = productEnv('USE_EDGE_PROFILE') === '1';
  return {
    key,
    name,
    baseUrl: productEnv('URL'),
    homePath: '/',
    username: productEnv('USER') || readEnv('SMOKE_USER'),
    password: productEnv('PASSWORD') || readEnv('SMOKE_PASSWORD'),
    login: defaultFormLogin,
    loggedInIndicator: 'text=/log ?out|sign ?out/i',
    pages: [{ name: 'Home', path: '/', expect: 'body' }],
    useEdgeProfile,
    maxWorkers: useEdgeProfile ? 1 : undefined,
    env: productEnv,
    ...overrides,
  };
}
