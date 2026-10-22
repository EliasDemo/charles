import { Injectable, Logger } from '@nestjs/common';

/**
 * Emisión de boletas electrónicas (SUNAT). Cada barbería usa **su propia cuenta** en un proveedor
 * autorizado (OSE/PSE); Charles solo envía los datos de la venta.
 *
 * - `FAKE`: simulado (desarrollo, pruebas y demostración): numera y "acepta" sin enviar nada.
 * - `NUBEFACT`: API JSON de Nubefact (autorizado como OSE y PSE). Con su RUTA y TOKEN.
 *
 * Los montos llegan con IGV incluido (precios al público); el proveedor recibe la base y el IGV.
 */

export interface InvoiceLine {
  description: string;
  quantity: number;
  /** Céntimos con IGV, por unidad. */
  unitAmount: number;
  totalAmount: number;
}

export interface InvoiceRequest {
  series: string;
  number: number;
  issuedAt: Date;
  currency: string;
  totalAmount: number;
  taxAmount: number;
  customer: {
    docType: 'DNI' | 'CE' | 'RUC' | 'NONE';
    docNumber: string | null;
    name: string | null;
  };
  lines: InvoiceLine[];
}

export interface InvoiceCredentials {
  apiUrl: string | null;
  token: string | null;
}

export interface InvoiceResult {
  status: 'ISSUED' | 'REJECTED';
  pdfUrl: string | null;
  providerData: Record<string, unknown>;
  error: string | null;
}

/** El proveedor no respondió: se reintenta. */
export class InvoiceProviderError extends Error {}

export const IGV_RATE = 0.18;

/** IGV contenido en un precio con IGV (redondeo al céntimo). */
export function taxIncluded(total: number): number {
  return total - Math.round(total / (1 + IGV_RATE));
}

@Injectable()
export class FakeInvoiceProvider {
  issue(req: InvoiceRequest): Promise<InvoiceResult> {
    const code = `${req.series}-${String(req.number).padStart(8, '0')}`;
    return Promise.resolve({
      status: 'ISSUED',
      pdfUrl: `https://fake.invoices/${code}.pdf`,
      providerData: { simulated: true, code },
      error: null,
    });
  }
}

const DOC_CODE: Record<string, string> = { DNI: '1', CE: '4', RUC: '6', NONE: '-' };
const cents = (v: number): number => Math.round(v) / 100;

@Injectable()
export class NubefactInvoiceProvider {
  private readonly logger = new Logger(NubefactInvoiceProvider.name);

  /**
   * `operacion: generar_comprobante`, tipo 2 (boleta), moneda 1 (soles), IGV 18 %, servicios con
   * unidad "ZZ". Nubefact firma, envía a SUNAT y devuelve el enlace al PDF.
   */
  async issue(req: InvoiceRequest, credentials: InvoiceCredentials): Promise<InvoiceResult> {
    if (!credentials.apiUrl || !credentials.token) {
      return {
        status: 'REJECTED',
        pdfUrl: null,
        providerData: {},
        error: 'Sin RUTA o TOKEN de Nubefact',
      };
    }
    const base = req.totalAmount - req.taxAmount;
    const items = req.lines.map((l) => {
      const lineTax = taxIncluded(l.totalAmount);
      const unitBase = Math.round(l.unitAmount / (1 + IGV_RATE));
      return {
        unidad_de_medida: 'ZZ',
        codigo: '',
        descripcion: l.description.slice(0, 250),
        cantidad: l.quantity,
        valor_unitario: cents(unitBase),
        precio_unitario: cents(l.unitAmount),
        subtotal: cents(l.totalAmount - lineTax),
        tipo_de_igv: 1,
        igv: cents(lineTax),
        total: cents(l.totalAmount),
        anticipo_regularizacion: false,
      };
    });
    const body = {
      operacion: 'generar_comprobante',
      tipo_de_comprobante: 2,
      serie: req.series,
      numero: req.number,
      sunat_transaction: 1,
      cliente_tipo_de_documento: DOC_CODE[req.customer.docType] ?? '-',
      cliente_numero_de_documento: req.customer.docNumber ?? '-',
      cliente_denominacion: req.customer.name ?? 'VARIOS',
      cliente_direccion: '',
      fecha_de_emision: formatDate(req.issuedAt),
      moneda: 1,
      porcentaje_de_igv: 18,
      total_gravada: cents(base),
      total_igv: cents(req.taxAmount),
      total: cents(req.totalAmount),
      enviar_automaticamente_a_la_sunat: true,
      enviar_automaticamente_al_cliente: false,
      items,
    };
    let res: Response;
    try {
      res = await fetch(credentials.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Token token="${credentials.token}"`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new InvoiceProviderError(`Nubefact no respondió (${(error as Error).name})`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new InvoiceProviderError(`Nubefact respondió ${res.status} sin JSON`);
    }
    if (res.status >= 500) throw new InvoiceProviderError(`Nubefact respondió ${res.status}`);
    if (!res.ok || parsed.errors) {
      this.logger.warn({ status: res.status }, 'Nubefact rechazó la boleta');
      return {
        status: 'REJECTED',
        pdfUrl: null,
        providerData: { errors: parsed.errors ?? null, codigo: parsed.codigo ?? null },
        error: typeof parsed.errors === 'string' ? parsed.errors : `Rechazada (${res.status})`,
      };
    }
    return {
      status: 'ISSUED',
      pdfUrl: typeof parsed.enlace_del_pdf === 'string' ? parsed.enlace_del_pdf : null,
      providerData: {
        aceptadaPorSunat: parsed.aceptada_por_sunat ?? null,
        sunatDescription: parsed.sunat_description ?? null,
        enlace: parsed.enlace ?? null,
      },
      error: null,
    };
  }
}

function formatDate(d: Date): string {
  // Fecha de Lima (UTC−5) en DD-MM-YYYY, como pide Nubefact.
  const lima = new Date(d.getTime() - 5 * 3_600_000);
  const dd = String(lima.getUTCDate()).padStart(2, '0');
  const mm = String(lima.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${lima.getUTCFullYear()}`;
}
