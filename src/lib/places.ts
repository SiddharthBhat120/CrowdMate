import { idb, type Place, type PlaceKind } from './idb';

/** Remember something on this phone so it shows on the home screen (works offline). */
export function savePlace(kind: PlaceKind, eventId: string, eventName: string, refId: string, label: string) {
  const place: Place = {
    key: `${kind}:${eventId}:${refId}`,
    kind,
    eventId,
    eventName,
    refId,
    label,
    savedAt: Date.now(),
  };
  return idb.put('places', place);
}

export async function listPlaces(): Promise<Place[]> {
  const places = await idb.getAll('places');
  return places.sort((a, b) => b.savedAt - a.savedAt);
}

export function forgetPlace(key: string) {
  return idb.delete('places', key);
}

export function placeHref(place: Place): string {
  switch (place.kind) {
    case 'organizer':
      return `/organize/${place.eventId}`;
    case 'ticket':
      return `/ticket/${place.eventId}/${place.refId}`;
    case 'tag':
      return `/tag/${place.eventId}/${place.refId}`;
    case 'event':
      return `/e/${place.eventId}`;
  }
}
