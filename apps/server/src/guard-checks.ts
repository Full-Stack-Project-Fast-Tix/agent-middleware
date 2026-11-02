import { agentIntentCheck } from "./check-agent-intent.js";
import { outboundBlobCheck } from "./check-outbound-blob.js";
import { learnedWatchCheck } from "./check-learned-watch.js";
import { sensitiveEgressCheck } from "./check-sensitive-egress.js";
import type { Check } from "./checks.js";
import type { AppConfig } from "./config.js";
import { paramsFrom, type Reflection } from "./reflections.js";

/**
 * The guard checks that run against a turn, one family per `GUARDRAIL_*_ENABLED`
 * flag. Each flag is independent so a guard can be tested on its own; there is
 * no master switch. An empty list means observe-only — no interception.
 *
 * This is where a registry belongs once the family grows further.
 */
export function buildGuardChecks(config: AppConfig, reflections: Reflection[] = []): Check[] {
  const checks: Check[] = [];

  if (config.reflectionGuardEnabled && reflections.length > 0) {
    const markers = config.guardrailSensitiveMarkers;
    checks.push(
      learnedWatchCheck({
        learned: paramsFrom(reflections),
        ...(markers.length > 0 ? { sensitiveMarkers: markers } : {}),
        minBlobChars: config.guardrailBlobMinChars,
      }),
    );
  }

  if (config.egressGuardEnabled) {
    const markers = config.guardrailSensitiveMarkers;
    const markerOption = markers.length > 0 ? { sensitiveMarkers: markers } : {};
    checks.push(
      sensitiveEgressCheck(markerOption),
      outboundBlobCheck({
        ...markerOption,
        minBlobChars: config.guardrailBlobMinChars,
      }),
    );
  }

  if (config.intentGuardEnabled) {
    checks.push(agentIntentCheck());
  }

  return checks;
}
