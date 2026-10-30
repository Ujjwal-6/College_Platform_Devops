import { useEffect, useState, type RefObject } from 'react';

interface Item {
  id: string;
  label: string;
}
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const MIN_SECTIONS = 4;

/**
 * A sticky menu for a long page, built from the page's own h2 headings, so it lists exactly the
 * sections that are shown to this person (sections load by themselves, so it watches for changes).
 */
export function SectionNav({ root }: { root: RefObject<HTMLElement | null> }) {
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [top, setTop] = useState(56);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = () => {
      const found: Item[] = [];
      el.querySelectorAll('h2').forEach((h) => {
        const label = h.textContent?.trim() ?? '';
        if (!label) return;
        if (!h.id) h.id = `section-${slug(label)}`;
        found.push({ id: h.id, label });
      });
      setItems((prev) =>
        prev.length === found.length && prev.every((p, i) => p.id === found[i]!.id) ? prev : found,
      );
      setTop(document.querySelector('.topbar')?.getBoundingClientRect().height ?? 56);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(scan, 100);
    };
    scan();
    const observer = new MutationObserver(schedule);
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [root]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || items.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-120px 0px -65% 0px' },
    );
    items.forEach((i) => {
      const h = document.getElementById(i.id);
      if (h) observer.observe(h);
    });
    return () => observer.disconnect();
  }, [items]);

  if (items.length < MIN_SECTIONS) return null;
  return (
    <nav className="subnav" aria-label="On this page" style={{ top }}>
      {items.map((i) => (
        <a
          key={i.id}
          href={`#${i.id}`}
          className={active === i.id ? 'active' : undefined}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(i.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setActive(i.id);
          }}
        >
          {i.label}
        </a>
      ))}
    </nav>
  );
}
