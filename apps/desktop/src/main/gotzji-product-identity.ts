import identity from './gotzji-product-identity.json' with { type: 'json' };

declare const __GOTZJI_PRODUCT__: boolean | undefined;

/** Owned product identity. Internal upstream package and native-helper names are retained. */
export const GOTZJI_PRODUCT_ENABLED = typeof __GOTZJI_PRODUCT__ === 'boolean' ? __GOTZJI_PRODUCT__ : true;
export const GOTZJI_APP_NAME = identity.name;
export const GOTZJI_APP_ID = identity.appId;
export const GOTZJI_REPOSITORY_URL = identity.repositoryUrl;
export const GOTZJI_AUTOMATIC_UPDATES_ENABLED = identity.automaticUpdatesEnabled;
export const GOTZJI_RELEASE_TRUST_POLICY = identity.releaseTrustPolicy;
