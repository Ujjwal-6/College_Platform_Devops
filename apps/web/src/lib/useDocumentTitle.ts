import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const SUFFIX = 'College Events';

/** Keeps the browser tab's title in step with the page's main heading ("Events · College Events"). */
export function useDocumentTitle(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const heading = document.querySelector('h1')?.textContent?.trim();
      document.title = heading ? `${heading} · ${SUFFIX}` : SUFFIX;
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 120);
    };
    update();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [pathname]);
}
