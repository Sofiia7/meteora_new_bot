import { config } from './config';

/**
 * Единое место для всех внешних ссылок на ресурсы по токену/пулу.
 *
 * Шаблоны URL живут в config.links (с override через .env), чтобы поправить
 * адрес ресурса без правки кода. Здесь — только сборка ссылок из шаблонов.
 *
 * Presentation-agnostic: возвращаем {label,url}, а как рендерить (HTML inline /
 * кнопки) решает вызывающий код (bot).
 */

export interface ResourceLink {
  label: string;
  url: string;
}

/**
 * Подставляет {placeholder} в шаблон. Если хоть один плейсхолдер не заполнен —
 * возвращает null (ссылку не показываем, чтобы не было битых URL).
 */
function fill(template: string, vars: Record<string, string>): string | null {
  let ok = true;
  const url = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (!v) ok = false;
    return v ?? '';
  });
  return ok ? url : null;
}

/**
 * Ссылки на ресурсы по токену.
 * @param ca          mint-адрес токена
 * @param pairAddress адрес пары/пула (нужен для DexScreener/Photon). Может быть пустым.
 */
export function tokenLinks(ca: string, pairAddress?: string): ResourceLink[] {
  const L = config.links;
  const hasPair = !!pairAddress && pairAddress.length > 0;
  // DexScreener принимает и адрес токена — при отсутствии пары падаем на CA.
  const dexParam = hasPair ? (pairAddress as string) : ca;

  const candidates: Array<[string, string | null]> = [
    ['GMGN', fill(L.gmgn, { ca })],
    ['Axiom', fill(L.axiom, { ca })],
    ['BubbleMaps', fill(L.bubblemaps, { ca })],
    ['RugCheck', fill(L.rugcheck, { ca })],
    ['DexScreener', fill(L.dexscreener, { pair: dexParam })],
    ['Solscan', fill(L.solscan, { ca })],
  ];

  // Photon работает по адресу пары/пула — без неё ссылку не строим.
  if (hasPair) {
    candidates.push(['Photon', fill(L.photon, { pair: pairAddress as string })]);
  }

  return candidates
    .filter((c): c is [string, string] => c[1] !== null)
    .map(([label, url]) => ({ label, url }));
}

/** Ссылка на конкретный DLMM-пул на Meteora (для входа вручную / просмотра). */
export function meteoraPoolUrl(poolAddress: string): string | null {
  return fill(config.links.meteoraPool, { pool: poolAddress });
}
