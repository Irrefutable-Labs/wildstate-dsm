import { watch } from 'vue';

/** Where this browser keeps its Wildstate resume token, which the game server issued at connect (Web2 only). */
export const RESUME_KEY = 'wildstate.dsm.resume';

/** Keeps the game's login for this browser as the server issues it, so reopening the game resumes the connection. */
export function keepResumeToken(token: () => string | null | undefined) {
  watch(
    token,
    (value) => {
      if (!value) return;
      try {
        window.localStorage.setItem(RESUME_KEY, value);
      } catch (e: unknown) {
        console.warn('the resume token could not be kept', e);
      }
    },
    { immediate: true },
  );
}
