export { GastronoviClient, parseCodeOrUnit, TOKEN_TTL_MS } from "./client.js";
export type { ClientOptions } from "./client.js";
export { asTransportError, GastronoviError } from "./error.js";
export type { GastronoviFailureReason } from "./error.js";
export { apiQuery, baseHeaders, GASTRONOVI_ORIGIN } from "./http.js";
export { menuFromPayload, parsePrice } from "./menu.js";
export type {
  Menu,
  MenuCategory,
  MenuItem,
  RawMenusection,
  RawMenusectionContent,
  RawMenusResponse,
  RawRecipe,
  RawRecipeStockRow,
} from "./menu.js";
export { bytesToHex, hexToBytes, nodeHasher, solveAltcha } from "./pow.js";
export type { AltchaChallenge, AltchaParameters, AltchaSolution, Pbkdf2Hasher, SolveOptions } from "./pow.js";
export { orderMode, unitId } from "./types.js";
export type { OrderMode, Unit, UnitId } from "./types.js";
export const PLATFORM = "gastronovi";
