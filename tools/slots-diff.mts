import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = b.contexts()[0]!.pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'))!;
const qs = new URLSearchParams({ idClinic: '1795', idSpecialty: '625', idProfessional: '17784', initialDate: '20261108', finalDate: '20261122', initialHour: '00:00', endHour: '23:59', fetchPolicy: 'network-only', cancelledAppointments: 'false' });
const data = await page.evaluate(async (u) => (await fetch(u, { credentials: 'same-origin' })).json(), `/api/v1/slots/list-slots-by-professional?${qs}`) as Array<{ hours: Array<Record<string, unknown>> }>;
const hrs = data.flatMap(d => d.hours);
console.log('Livre:', hrs.filter(h => h.status === 'Livre').map(h => `${h.formatedHour}(prof ${h.idProfessional}, esp ${h.specialtyId})`).join(', '));
console.log('todos:', hrs.map(h => `${h.formatedHour}:${h.status}`).join(' '));
process.exit(0);
