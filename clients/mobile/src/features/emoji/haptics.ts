import {haptics} from '../../lib/haptics';

/**
 * #4298 is on S1/track/uxui; this S3 slot starts on track/engine before sync.
 * Call ONLY its event API once present. No legacy fallback or independent native pulse.
 * Reaction confirmation belongs to MessageRow's `reactionChanged` event (#4298),
 * so the picker does not also emit for the same reaction selection.
 */
export function emojiHaptic(
  event: 'tabChanged' | 'filterChanged' | 'reactionCandidateChanged',
): void {
  const module = haptics as typeof haptics & {
    event?: (name: typeof event) => void;
  };
  module.event?.(event);
}
