"""Genera Charles_BSC.xlsx: Balanced Scorecard funcional de Charles."""
import sys
from openpyxl import Workbook
from openpyxl.chart import BarChart, DoughnutChart, LineChart, Reference
from openpyxl.comments import Comment
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Protection, Side
from openpyxl.utils import get_column_letter as L
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

OUT = sys.argv[1]
CARBON, GOLD, PETROL, GREEN, AMBER, CORAL, BONE = '16181D', 'C9A227', '1F6F78', '2E9E6B', 'E3A72F', 'E0644A', 'F7F5F0'
INPUT = 'FFF6CC'
FONT = 'Arial'
MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
P = "'Parámetros'"
D = 'Datos_Mensuales'

def fill(c): return PatternFill('solid', start_color=c, end_color=c)
thin = Side(style='thin', color='D9D6CE')
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)

def font(**k):
    k.setdefault('name', FONT); k.setdefault('size', 10)
    return Font(**k)

def header(ws, row, col, values, widths=None):
    for i, v in enumerate(values):
        c = ws.cell(row=row, column=col + i, value=v)
        c.font = font(bold=True, color='FFFFFF'); c.fill = fill(CARBON)
        c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True); c.border = BOX
    if widths:
        for i, w in enumerate(widths):
            ws.column_dimensions[L(col + i)].width = w

def title(ws, text, sub=None):
    ws['A1'] = text; ws['A1'].font = font(size=18, bold=True, color=CARBON)
    if sub:
        ws['A2'] = sub; ws['A2'].font = font(size=10, italic=True, color='666666')
    ws.sheet_properties.tabColor = GOLD

def inp(c):
    c.fill = fill(INPUT); c.protection = Protection(locked=False); c.font = font(color='0000FF')

wb = Workbook()
ws_inicio = wb.active; ws_inicio.title = 'Inicio'
ws_par = wb.create_sheet('Parámetros')
ws_dat = wb.create_sheet(D)
ws_ind = wb.create_sheet('Indicadores')
ws_map = wb.create_sheet('Mapa_Estrategico')
ws_dash = wb.create_sheet('Dashboard')
ws_ini = wb.create_sheet('Iniciativas')
ws_ten = wb.create_sheet('Tendencias')
ws_glo = wb.create_sheet('Glosario')

def name(n, ref):
    wb.defined_names[n] = DefinedName(n, attr_text=ref)

# ───────────────────────── Parámetros ─────────────────────────
ws = ws_par
title(ws, 'Parámetros', 'Celdas amarillas: editables. Todo el libro se recalcula a partir de aquí y de Datos_Mensuales.')
ws.column_dimensions['A'].width = 3; ws.column_dimensions['B'].width = 40; ws.column_dimensions['C'].width = 16; ws.column_dimensions['D'].width = 50
params = [
    ('Año del plan', 'AnioPlan', 2027, '0', 'Año al que corresponden metas y datos.'),
    ('Mes actual (para el tablero)', 'MesActual', 'jun', '@', 'Cambia el mes y se actualiza todo.'),
    ('Índice del mes (calculado)', 'MesIdx', None, '0', 'No editar: posición del mes (1 a 12).'),
    ('Precio plan Pro (S/ al mes)', 'PrecioPro', 59, '"S/ "#,##0', 'Valor de demostración.'),
    ('Precio plan Premium (S/ al mes)', 'PrecioPremium', 129, '"S/ "#,##0', 'Valor de demostración.'),
    ('Comisión por reserva — Gratis', 'ComGratis', 0.08, '0.0%', 'Referencia (no entra en fórmulas).'),
    ('Comisión por reserva — Pro', 'ComPro', 0.05, '0.0%', 'Referencia (no entra en fórmulas).'),
    ('Comisión por reserva — Premium', 'ComPremium', 0.03, '0.0%', 'Referencia (no entra en fórmulas).'),
    ('Peso perspectiva Financiera', 'PesoFinanciera', 0.30, '0%', ''),
    ('Peso perspectiva Cliente', 'PesoCliente', 0.30, '0%', ''),
    ('Peso perspectiva Procesos', 'PesoProcesos', 0.25, '0%', ''),
    ('Peso perspectiva Aprendizaje', 'PesoAprendizaje', 0.15, '0%', ''),
    ('Suma de pesos (debe ser 100 %)', 'SumaPesos', None, '0%', ''),
    ('Umbral VERDE (cumplimiento ≥)', 'UmbralVerde', 1.0, '0%', 'Desde aquí el indicador está en verde.'),
    ('Umbral AMARILLO (cumplimiento ≥)', 'UmbralAmarillo', 0.8, '0%', 'Entre amarillo y verde: amarillo. Debajo: rojo.'),
    ('Tope de cumplimiento', 'TopeCumpl', 1.2, '0%', 'Evita que un indicador muy alto tape a los demás.'),
    ('Minutos del mes (disponibilidad)', 'MinutosMes', 43200, '#,##0', '30 días × 1 440 minutos.'),
]
header(ws, 3, 2, ['Parámetro', 'Valor', 'Nota'])
for i, (lab, nm, val, fmt, note) in enumerate(params):
    r = 4 + i
    ws.cell(row=r, column=2, value=lab).font = font()
    c = ws.cell(row=r, column=3); c.number_format = fmt; c.border = BOX
    if val is not None:
        c.value = val; inp(c)
    else:
        c.font = font(bold=True)
    ws.cell(row=r, column=4, value=note).font = font(size=9, color='666666')
    name(nm, f"{P}!$C${r}")
# meses
ws['F3'] = 'Meses'; ws['F3'].font = font(bold=True, color='FFFFFF'); ws['F3'].fill = fill(CARBON)
for i, m in enumerate(MESES):
    ws.cell(row=4 + i, column=6, value=m).font = font()
name('ListaMeses', f"{P}!$F$4:$F$15")
row_of = {nm: 4 + i for i, (_, nm, *_r) in enumerate(params)}
ws.cell(row=row_of['MesIdx'], column=3, value='=MATCH(MesActual,ListaMeses,0)')
ws.cell(row=row_of['SumaPesos'], column=3, value='=PesoFinanciera+PesoCliente+PesoProcesos+PesoAprendizaje')
r = row_of['SumaPesos']
ws.cell(row=r, column=4, value=f'=IF(ROUND(C{r},4)=1,"✔ Correcto","⚠ Los pesos deben sumar 100 %")')
ws.conditional_formatting.add(f'D{r}', FormulaRule(formula=[f'ROUND($C${r},4)<>1'], font=Font(color=CORAL, bold=True)))
dv = DataValidation(type='list', formula1='=ListaMeses', allow_blank=False); ws.add_data_validation(dv); dv.add(f"C{row_of['MesActual']}")
dvp = DataValidation(type='decimal', operator='between', formula1='0', formula2='1'); ws.add_data_validation(dvp)
for nm in ['PesoFinanciera', 'PesoCliente', 'PesoProcesos', 'PesoAprendizaje', 'UmbralAmarillo']:
    dvp.add(f'C{row_of[nm]}')
ws['F17'] = 'Responsables'; ws['F17'].font = font(bold=True, color='FFFFFF'); ws['F17'].fill = fill(CARBON)
for i, v in enumerate(['Dirección', 'Comercial', 'Producto', 'Operaciones', 'Soporte']):
    ws.cell(row=18 + i, column=6, value=v).font = font()
name('ListaResp', f"{P}!$F$18:$F$22")
ws.column_dimensions['F'].width = 14

# ───────────────────────── Datos_Mensuales ─────────────────────────
fields = [  # key, etiqueta, formato
    ('gratis_ini', 'Barberías Gratis al inicio', '#,##0'), ('gratis_fin', 'Barberías Gratis al cierre', '#,##0'),
    ('pro_ini', 'Barberías Pro al inicio', '#,##0'), ('pro_fin', 'Barberías Pro al cierre', '#,##0'),
    ('prem_ini', 'Barberías Premium al inicio', '#,##0'), ('prem_fin', 'Barberías Premium al cierre', '#,##0'),
    ('nuevas', 'Barberías nuevas registradas', '#,##0'), ('altas', 'Altas a plan de pago', '#,##0'),
    ('bajas', 'Bajas de plan de pago', '#,##0'),
    ('ing_susc', 'Ingreso suscripciones (S/) — calculado', '"S/ "#,##0'), ('ing_com', 'Ingreso comisiones (S/)', '"S/ "#,##0'),
    ('ing_ausp', 'Ingreso auspiciadores (S/)', '"S/ "#,##0'), ('ing_dest', 'Ingreso destacados (S/)', '"S/ "#,##0'),
    ('ing_va', 'Ingreso valor agregado (S/)', '"S/ "#,##0'), ('costos', 'Costos directos (S/)', '"S/ "#,##0'),
    ('mkt', 'Gasto marketing y ventas (S/)', '"S/ "#,##0'),
    ('mau', 'Usuarios activos (MAU)', '#,##0'), ('atendidos', 'Clientes atendidos', '#,##0'),
    ('recurrentes', 'Clientes recurrentes (≥2 en 60 días)', '#,##0'),
    ('res_conf', 'Reservas confirmadas', '#,##0'), ('inasist', 'Inasistencias', '#,##0'),
    ('res_app', 'Reservas pagadas en la app', '#,##0'), ('boletas', 'Ventas en local con boleta', '#,##0'),
    ('pag_int', 'Intentos de pago', '#,##0'), ('pag_ok', 'Pagos aprobados', '#,##0'),
    ('cup_emit', 'Cupones emitidos', '#,##0'), ('cup_canje', 'Cupones canjeados', '#,##0'),
    ('impr', 'Impresiones de anuncios', '#,##0'), ('clics', 'Clics en anuncios', '#,##0'),
    ('ausp', 'Auspiciadores con campaña activa', '#,##0'),
    ('tickets', 'Tickets de soporte cerrados', '#,##0'), ('horas_tk', 'Horas totales de resolución', '#,##0'),
    ('caida', 'Minutos de caída del servicio', '#,##0'),
    ('perfiles', 'Barberos con perfil completo', '#,##0'), ('barberos', 'Barberos registrados', '#,##0'),
    ('videos', 'Videos de portafolio publicados', '#,##0'),
    ('ent_ok', 'Entregas a tiempo', '#,##0'), ('ent_plan', 'Entregas planificadas', '#,##0'),
    ('cobertura', 'Cobertura de pruebas', '0%'), ('ia', 'Usuarios de forma de cara', '#,##0'),
    ('cap', 'Horas de capacitación', '#,##0'),
    ('nps', 'NPS barberías (trimestral)', '0'), ('valor', 'Valoración promedio (1–5)', '0.00'),
]
COL = {k: L(2 + i) for i, (k, *_r) in enumerate(fields)}
ws = ws_dat
title(ws, 'Datos mensuales', 'Una fila por mes. Amarillo = dato a ingresar. ene–jun traen datos de ejemplo (demo); jul–dic se llenan cada mes.')
header(ws, 4, 1, ['Mes'] + [f[1] for f in fields])
ws.row_dimensions[4].height = 48
ws.column_dimensions['A'].width = 7
for i in range(len(fields)):
    ws.column_dimensions[L(2 + i)].width = 13

pro = [40, 55, 72, 80, 96, 115]; prem = [8, 11, 15, 16, 20, 25]; bajas = [1, 2, 2, 6, 3, 3]
nuevas = [45, 52, 61, 38, 66, 74]; res_app = [2200, 2800, 3500, 3300, 4400, 5300]
inas = [.07, .075, .068, .11, .07, .065]; okr = [.93, .925, .94, .89, .935, .94]
caida = [60, 20, 15, 300, 25, 10]; tk = [80, 95, 110, 130, 120, 135]; hrs = [30, 26, 22, 35, 20, 18]
sample = []
g_ini, p_ini, pr_ini = 300, 30, 6
for m in range(6):
    altas = (pro[m] - p_ini) + (prem[m] - pr_ini) + bajas[m]
    g_fin = g_ini + nuevas[m] - altas + bajas[m]
    com = round(res_app[m] * 30 * 0.06)
    ausp_i = [1500, 1800, 2500, 2200, 3200, 3800][m]; dest = [300, 400, 550, 500, 700, 850][m]; va = [100, 150, 220, 240, 330, 420][m]
    total = pro[m] * 59 + prem[m] * 129 + com + ausp_i + dest + va
    mau = [3200, 4100, 5000, 5200, 6300, 7400][m]; bol = [600, 900, 1400, 1600, 2200, 2900][m]
    at = round(res_app[m] * 0.95 + bol); conf = round(res_app[m] * 1.05); pint = round(res_app[m] * 1.08)
    emit = [2000, 2400, 3000, 3100, 3800, 4500][m]; canje = round(emit * [.12, .13, .15, .11, .16, .17][m])
    impr = [150000, 180000, 230000, 220000, 300000, 360000][m]
    barb = [400, 430, 470, 490, 530, 580][m]
    sample.append(dict(
        gratis_ini=g_ini, gratis_fin=g_fin, pro_ini=p_ini, pro_fin=pro[m], prem_ini=pr_ini, prem_fin=prem[m],
        nuevas=nuevas[m], altas=altas, bajas=bajas[m], ing_com=com, ing_ausp=ausp_i, ing_dest=dest, ing_va=va,
        costos=round(total * [.32, .31, .3, .34, .28, .27][m]), mkt=[12000, 13000, 15000, 16000, 18000, 20000][m],
        mau=mau, atendidos=at, recurrentes=round(at * [.38, .4, .42, .37, .44, .46][m]),
        res_conf=conf, inasist=round(conf * inas[m]), res_app=res_app[m], boletas=bol,
        pag_int=pint, pag_ok=round(pint * okr[m]), cup_emit=emit, cup_canje=canje,
        impr=impr, clics=round(impr * [.021, .023, .026, .022, .027, .028][m]), ausp=[2, 2, 3, 3, 4, 5][m],
        tickets=tk[m], horas_tk=tk[m] * hrs[m], caida=caida[m],
        perfiles=round(barb * [.45, .48, .52, .53, .58, .62][m]), barberos=barb,
        videos=[90, 130, 170, 160, 240, 310][m], ent_ok=[4, 5, 6, 3, 7, 6][m], ent_plan=[5, 6, 7, 6, 8, 7][m],
        cobertura=[.82, .83, .84, .81, .85, .86][m], ia=round(mau * [.05, .06, .07, .07, .09, .11][m]),
        cap=[10, 12, 16, 8, 18, 16][m], nps=[None, None, 38, None, None, 44][m],
        valor=[4.4, 4.45, 4.5, 4.35, 4.55, 4.6][m]))
    g_ini, p_ini, pr_ini = g_fin, pro[m], prem[m]

for m in range(12):
    r = 5 + m
    ws.cell(row=r, column=1, value=MESES[m]).font = font(bold=True)
    for k, lab, fmt in fields:
        c = ws[f'{COL[k]}{r}']; c.number_format = fmt; c.border = BOX
        if k == 'ing_susc':
            pf, pm = COL['pro_fin'], COL['prem_fin']
            c.value = f'=IF({pf}{r}="","",{pf}{r}*PrecioPro+{pm}{r}*PrecioPremium)'
            c.font = font(); c.fill = fill('EEEEEE')
            continue
        inp(c)
        if m < 6 and sample[m].get(k) is not None:
            c.value = sample[m][k]
ws.freeze_panes = 'B5'
dvn = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1='0', error='Solo números ≥ 0')
ws.add_data_validation(dvn); dvn.add(f'B5:{L(1 + len(fields))}16')
ws['A18'] = 'Supuestos de los datos de ejemplo (demo): ticket promedio S/ 30, comisión media 6 %, crecimiento mensual de barberías de pago; abril es un mes malo a propósito (caída del servicio, más bajas e inasistencias) para ver semáforos en rojo. El NPS se mide en marzo y junio.'
ws['A18'].font = font(size=9, italic=True, color='666666')

# ───────────────────────── Indicadores (definición) ─────────────────────────
def c_(k, off=0):
    return f'{D}!${COL[k]}{{r{"" if off == 0 else "p"}}}'

TOT = '({s}+{c}+{a}+{d}+{v})'.format(s=c_('ing_susc'), c=c_('ing_com'), a=c_('ing_ausp'), d=c_('ing_dest'), v=c_('ing_va'))
CHURN = f"{c_('bajas')}/({c_('pro_ini')}+{c_('prem_ini')})"
ARPU = f"{TOT}/({c_('pro_fin')}+{c_('prem_fin')})"
MARGEN = f"({TOT}-{c_('costos')})/{TOT}"
MRR = f"{c_('pro_fin')}*PrecioPro+{c_('prem_fin')}*PrecioPremium"
MRRp = f"{c_('pro_fin', 1)}*PrecioPro+{c_('prem_fin', 1)}*PrecioPremium"
IND = [
    # persp, cod, objetivo, indicador, fórmula texto, unidad, frecuencia, polaridad, meta, resp, iniciativa, expr, claves
    ('Financiera', 'F1', 'Crecer ingresos recurrentes', 'MRR (ingreso mensual recurrente)', 'Pro × precio Pro + Premium × precio Premium', 'S/', 'Mensual', '↑', 15000, 'Dirección', 'I1', MRR, ['pro_fin']),
    ('Financiera', 'F2', 'Crecer ingresos recurrentes', 'Crecimiento del MRR', '(MRR mes − MRR mes anterior) / MRR mes anterior', '%', 'Mensual', '↑', 0.08, 'Dirección', 'I1', f'(({MRR})-({MRRp}))/({MRRp})', ['pro_fin', 'pro_fin@p']),
    ('Financiera', 'F3', 'Diversificar ingresos', '% ingresos no de suscripción', '(comisiones + auspiciadores + destacados + valor agregado) / ingresos totales', '%', 'Mensual', '↑', 0.45, 'Comercial', 'I2, I4, I7', f"({c_('ing_com')}+{c_('ing_ausp')}+{c_('ing_dest')}+{c_('ing_va')})/{TOT}", ['ing_com']),
    ('Financiera', 'F4', 'Rentabilidad por cliente', 'ARPU por barbería de pago', 'ingresos totales / barberías de pago', 'S/', 'Mensual', '↑', 160, 'Comercial', 'I1', ARPU, ['pro_fin', 'ing_com']),
    ('Financiera', 'F5', 'Rentabilidad por cliente', 'Relación LTV / CAC', '(ARPU × margen / churn) / (marketing / altas de pago)', 'x', 'Mensual', '↑', 3, 'Dirección', 'I1, I3', f"(({ARPU})*({MARGEN})/({CHURN}))/({c_('mkt')}/{c_('altas')})", ['mkt', 'altas', 'bajas', 'costos']),
    ('Financiera', 'F6', 'Controlar costos', 'Margen bruto', '(ingresos − costos directos) / ingresos', '%', 'Mensual', '↑', 0.70, 'Operaciones', '—', MARGEN, ['costos', 'ing_com']),
    ('Cliente', 'C1', 'Captar barberías', 'Barberías nuevas registradas', 'conteo del mes', 'n.º', 'Mensual', '↑', 60, 'Comercial', 'I3', c_('nuevas'), ['nuevas']),
    ('Cliente', 'C2', 'Convertir a pago', 'Conversión Gratis → pago', 'altas de pago / Gratis al inicio', '%', 'Mensual', '↑', 0.06, 'Comercial', 'I1', f"{c_('altas')}/{c_('gratis_ini')}", ['altas', 'gratis_ini']),
    ('Cliente', 'C3', 'Retener barberías', 'Churn mensual de barberías de pago', 'bajas / barberías de pago al inicio', '%', 'Mensual', '↓', 0.04, 'Soporte', 'I2', CHURN, ['bajas', 'pro_ini']),
    ('Cliente', 'C4', 'Satisfacer a la barbería', 'NPS de barberías', '% promotores − % detractores', 'pts', 'Trimestral', '↑', 40, 'Soporte', 'I2', c_('nps'), ['nps']),
    ('Cliente', 'C5', 'Atraer usuarios finales', 'Usuarios activos mensuales (MAU)', 'usuarios con ≥1 sesión en el mes', 'n.º', 'Mensual', '↑', 8000, 'Producto', 'I8', c_('mau'), ['mau']),
    ('Cliente', 'C6', 'Fidelizar usuarios finales', 'Tasa de clientes recurrentes', 'recurrentes / atendidos', '%', 'Mensual', '↑', 0.45, 'Comercial', 'I5, I7', f"{c_('recurrentes')}/{c_('atendidos')}", ['recurrentes', 'atendidos']),
    ('Cliente', 'C7', 'Calidad percibida', 'Valoración promedio', 'promedio de estrellas del mes', '★', 'Mensual', '↑', 4.5, 'Operaciones', 'I5', c_('valor'), ['valor']),
    ('Cliente', 'C8', 'Atraer auspiciadores', 'Auspiciadores con campaña activa', 'conteo', 'n.º', 'Mensual', '↑', 5, 'Comercial', 'I4', c_('ausp'), ['ausp']),
    ('Procesos', 'P1', 'Reservas eficientes', 'Reservas pagadas en la app', 'conteo del mes', 'n.º', 'Mensual', '↑', 6000, 'Producto', 'I1', c_('res_app'), ['res_app']),
    ('Procesos', 'P2', 'Reservas eficientes', 'Tasa de inasistencia', 'inasistencias / reservas confirmadas', '%', 'Mensual', '↓', 0.08, 'Operaciones', 'I5', f"{c_('inasist')}/{c_('res_conf')}", ['inasist', 'res_conf']),
    ('Procesos', 'P3', 'Digitalizar el local', 'Ventas en el local con boleta', 'conteo del mes', 'n.º', 'Mensual', '↑', 3000, 'Producto', 'I2', c_('boletas'), ['boletas']),
    ('Procesos', 'P4', 'Pagos confiables', 'Tasa de pagos aprobados', 'aprobados / intentos', '%', 'Mensual', '↑', 0.92, 'Operaciones', '—', f"{c_('pag_ok')}/{c_('pag_int')}", ['pag_ok', 'pag_int']),
    ('Procesos', 'P5', 'Promociones efectivas', 'Tasa de canje de promociones', 'canjeados / emitidos', '%', 'Mensual', '↑', 0.15, 'Comercial', 'I2', f"{c_('cup_canje')}/{c_('cup_emit')}", ['cup_canje', 'cup_emit']),
    ('Procesos', 'P6', 'Auspiciadores rentables', 'CTR de campañas', 'clics / impresiones', '%', 'Mensual', '↑', 0.025, 'Comercial', 'I4', f"{c_('clics')}/{c_('impr')}", ['clics', 'impr']),
    ('Procesos', 'P7', 'Soporte ágil', 'Tiempo promedio de resolución', 'horas / tickets cerrados', 'h', 'Mensual', '↓', 24, 'Soporte', '—', f"{c_('horas_tk')}/{c_('tickets')}", ['horas_tk', 'tickets']),
    ('Procesos', 'P8', 'Plataforma estable', 'Disponibilidad del servicio', '1 − minutos de caída / minutos del mes', '%', 'Mensual', '↑', 0.995, 'Producto', '—', f"1-{c_('caida')}/MinutosMes", ['caida']),
    ('Aprendizaje', 'A1', 'Profesionalizar al barbero', 'Barberos con perfil completo', 'perfiles completos / barberos', '%', 'Mensual', '↑', 0.60, 'Producto', 'I6', f"{c_('perfiles')}/{c_('barberos')}", ['perfiles', 'barberos']),
    ('Aprendizaje', 'A2', 'Profesionalizar al barbero', 'Videos de portafolio publicados', 'conteo del mes', 'n.º', 'Mensual', '↑', 300, 'Producto', 'I6', c_('videos'), ['videos']),
    ('Aprendizaje', 'A3', 'Innovar el producto', 'Funciones entregadas a tiempo', 'a tiempo / planificadas', '%', 'Mensual', '↑', 0.80, 'Producto', '—', f"{c_('ent_ok')}/{c_('ent_plan')}", ['ent_ok', 'ent_plan']),
    ('Aprendizaje', 'A4', 'Calidad técnica', 'Cobertura de pruebas', '% de código cubierto', '%', 'Mensual', '↑', 0.80, 'Producto', '—', c_('cobertura'), ['cobertura']),
    ('Aprendizaje', 'A5', 'Uso de datos e IA', 'Uso de recomendación por forma de cara', 'usuarios que la usan / MAU', '%', 'Mensual', '↑', 0.10, 'Producto', 'I8', f"{c_('ia')}/{c_('mau')}", ['ia', 'mau']),
    ('Aprendizaje', 'A6', 'Equipo capacitado', 'Horas de capacitación', 'horas en el mes', 'h', 'Mensual', '↑', 16, 'Dirección', '—', c_('cap'), ['cap']),
]
UFMT = {'S/': '"S/ "#,##0', '%': '0.0%', 'x': '0.0"x"', 'n.º': '#,##0', 'pts': '0', '★': '0.00', 'h': '0.0'}
PERSP = ['Financiera', 'Cliente', 'Procesos', 'Aprendizaje']
PCOLOR = {'Financiera': GOLD, 'Cliente': PETROL, 'Procesos': '5B5F97', 'Aprendizaje': GREEN}
N = len(IND)

def expr_at(expr, keys, r):
    e = expr.replace('{rp}', str(r - 1)).replace('{r}', str(r))
    conds = []
    for k in keys:
        if k.endswith('@p'):
            conds.append(f'{D}!${COL[k[:-2]]}{r - 1}=""')
        else:
            conds.append(f'{D}!${COL[k]}{r}=""')
    return f'=IF(OR({",".join(conds)}),"",IFERROR({e},""))'

# ───────────────────────── Tendencias ─────────────────────────
ws = ws_ten
title(ws, 'Tendencias', 'Valor de cada indicador mes a mes (calculado desde Datos_Mensuales). Escala de color por fila.')
header(ws, 4, 1, ['Cód.', 'Indicador', 'Meta'] + MESES, [7, 36, 11] + [10] * 12)
TEN_ROW = {}
for i, it in enumerate(IND):
    r = 5 + i; TEN_ROW[it[1]] = r
    ws.cell(row=r, column=1, value=it[1]).font = font(bold=True)
    ws.cell(row=r, column=2, value=it[3]).font = font()
    mc = ws.cell(row=r, column=3, value=f'=Indicadores!I{5 + i}'); mc.number_format = UFMT[it[5]]; mc.font = font(color='008000')
    for m in range(12):
        c = ws.cell(row=r, column=4 + m, value=expr_at(it[11], it[12], 5 + m))
        c.number_format = UFMT[it[5]]; c.font = font(); c.border = BOX
    from openpyxl.formatting.rule import ColorScaleRule
    lo, hi = ('F8D7CF', 'CFEBDD') if it[7] == '↑' else ('CFEBDD', 'F8D7CF')
    ws.conditional_formatting.add(f'D{r}:O{r}', ColorScaleRule(start_type='min', start_color=lo, end_type='max', end_color=hi))
ws.freeze_panes = 'D5'
# Series auxiliares para gráficos
base = 5 + N + 2
ws.cell(row=base, column=1, value='Series para gráficos').font = font(bold=True)
aux = [
    ('MRR real', f'=Tendencias!{{c}}{TEN_ROW["F1"]}', UFMT['S/']),
    ('MRR meta', '=Indicadores!$I$5', UFMT['S/']),
    ('Churn real', f'=Tendencias!{{c}}{TEN_ROW["C3"]}', '0.0%'),
    ('Churn umbral', '=Indicadores!$I$13', '0.0%'),
]
header(ws, base + 1, 2, ['Serie', ''] + MESES)
for j, (lab, f, fmt) in enumerate(aux):
    r = base + 2 + j
    ws.cell(row=r, column=2, value=lab).font = font()
    for m in range(12):
        col = L(4 + m)
        v = f.replace('{c}', col)
        if lab.endswith('real'):
            v = f'=IF({col}{TEN_ROW["F1" if "MRR" in lab else "C3"]}="",NA(),{col}{TEN_ROW["F1" if "MRR" in lab else "C3"]})'
        c = ws.cell(row=r, column=4 + m, value=v); c.number_format = fmt; c.font = font(size=9)
AUX_MRR, AUX_CHURN = base + 2, base + 4
for rr in range(base, base + 8):
    ws.row_dimensions[rr].hidden = True
ws.cell(row=base + 7, column=2, value='Nota: los meses sin datos muestran #N/A solo en estas series auxiliares, para que el gráfico no dibuje ceros.').font = font(size=8, italic=True, color='888888')

# ───────────────────────── Indicadores (hoja) ─────────────────────────
ws = ws_ind
title(ws, 'Indicadores del Balanced Scorecard', '=CONCATENATE("Mes analizado: ",MesActual," ",AnioPlan,"  ·  Amarillo = editable (meta, peso, responsable)")')
cols = ['Perspectiva', 'Cód.', 'Objetivo', 'Indicador', 'Fórmula de cálculo', 'Unidad', 'Frecuencia', 'Polaridad', 'Meta', 'Línea base (ene)',
        'Umbral rojo', 'Peso en la perspectiva', 'Responsable', 'Iniciativa', 'Real del mes', 'Mes anterior', '% Cumplimiento',
        'Semáforo', 'Tendencia', 'Puntaje ponderado', 'Cumpl. numérico', 'Brecha (orden)']
header(ws, 4, 1, cols, [12, 6, 24, 30, 34, 7, 10, 8, 11, 11, 11, 10, 12, 10, 12, 12, 11, 10, 9, 10, 9, 9])
ws.row_dimensions[4].height = 36
count = {p: sum(1 for it in IND if it[0] == p) for p in PERSP}
for i, it in enumerate(IND):
    r = 5 + i; tr = TEN_ROW[it[1]]; fmt = UFMT[it[5]]
    vals = [it[0], it[1], it[2], it[3], it[4], it[5], it[6], it[7]]
    for j, v in enumerate(vals):
        c = ws.cell(row=r, column=1 + j, value=v); c.font = font(); c.border = BOX
        c.alignment = Alignment(vertical='center', wrap_text=j in (2, 3, 4))
    ws.cell(row=r, column=1).font = font(bold=True, color=PCOLOR[it[0]])
    m = ws.cell(row=r, column=9, value=it[8]); m.number_format = fmt; inp(m); m.border = BOX
    b = ws.cell(row=r, column=10, value=f'=Tendencias!D{tr}'); b.number_format = fmt
    u = ws.cell(row=r, column=11, value=f'=IF(H{r}="↑",I{r}*UmbralAmarillo,I{r}/UmbralAmarillo)'); u.number_format = fmt
    w = ws.cell(row=r, column=12, value=round(1 / count[it[0]], 4)); w.number_format = '0.0%'; inp(w)
    rs = ws.cell(row=r, column=13, value=it[9]); inp(rs)
    ws.cell(row=r, column=14, value=it[10]).font = font()
    real = ws.cell(row=r, column=15, value=f'=INDEX(Tendencias!$D{tr}:$O{tr},MesIdx)'); real.number_format = fmt; real.font = font(bold=True)
    prev = ws.cell(row=r, column=16, value=f'=IF(MesIdx>1,INDEX(Tendencias!$D{tr}:$O{tr},MesIdx-1),"")'); prev.number_format = fmt
    cu = ws.cell(row=r, column=17, value=f'=IF(O{r}="","—",IF(H{r}="↑",MIN(IFERROR(O{r}/I{r},0),TopeCumpl),IF(O{r}<=0,TopeCumpl,MIN(I{r}/O{r},TopeCumpl))))')
    cu.number_format = '0%'; cu.font = font(bold=True)
    ws.cell(row=r, column=18, value=f'=IF(Q{r}="—","Sin dato",IF(Q{r}>=UmbralVerde,"Verde",IF(Q{r}>=UmbralAmarillo,"Amarillo","Rojo")))')
    ws.cell(row=r, column=19, value=f'=IF(OR(O{r}="",P{r}=""),"▬",IF(O{r}=P{r},"▬",IF((O{r}>P{r})=(H{r}="↑"),"▲","▼")))')
    pp = ws.cell(row=r, column=20, value=f'=IF(Q{r}="—","—",Q{r}*L{r})'); pp.number_format = '0.0%'
    cn = ws.cell(row=r, column=21, value=f'=IF(ISNUMBER(Q{r}),Q{r},"")'); cn.number_format = '0%'
    br = ws.cell(row=r, column=22, value=f'=IF(ISNUMBER(Q{r}),1-Q{r}+ROW()/1000000,-1)'); br.number_format = '0.000'
    for col in range(9, 23):
        ws.cell(row=r, column=col).border = BOX
        if ws.cell(row=r, column=col).font.color is None or col not in (9, 12, 13):
            pass
last = 4 + N
rng = f'R5:R{last}'
ws.conditional_formatting.add(rng, FormulaRule(formula=['R5="Verde"'], fill=fill(GREEN), font=Font(color='FFFFFF', bold=True)))
ws.conditional_formatting.add(rng, FormulaRule(formula=['R5="Amarillo"'], fill=fill(AMBER), font=Font(color=CARBON, bold=True)))
ws.conditional_formatting.add(rng, FormulaRule(formula=['R5="Rojo"'], fill=fill(CORAL), font=Font(color='FFFFFF', bold=True)))
ws.conditional_formatting.add(f'S5:S{last}', FormulaRule(formula=['S5="▲"'], font=Font(color=GREEN, bold=True)))
ws.conditional_formatting.add(f'S5:S{last}', FormulaRule(formula=['S5="▼"'], font=Font(color=CORAL, bold=True)))
for col in 'RS':
    for r in range(5, last + 1):
        ws[f'{col}{r}'].alignment = Alignment(horizontal='center')
ws.column_dimensions['U'].hidden = True; ws.column_dimensions['V'].hidden = True
dvpol = DataValidation(type='list', formula1='"↑,↓"'); ws.add_data_validation(dvpol); dvpol.add(f'H5:H{last}')
dvfr = DataValidation(type='list', formula1='"Mensual,Trimestral,Anual"'); ws.add_data_validation(dvfr); dvfr.add(f'G5:G{last}')
dvr = DataValidation(type='list', formula1='=ListaResp'); ws.add_data_validation(dvr); dvr.add(f'M5:M{last}')
for r in range(5, last + 1):
    inp(ws[f'H{r}']); ws[f'H{r}'].border = BOX
# Resumen por perspectiva
s0 = last + 3
ws.cell(row=s0, column=3, value='Resumen por perspectiva').font = font(bold=True, size=12)
header(ws, s0 + 1, 3, ['Perspectiva', 'Peso', 'Cumplimiento', 'Semáforo', 'Aporte al índice', 'Suma de pesos internos'])
PS_ROW = {}
for j, p in enumerate(PERSP):
    r = s0 + 2 + j; PS_ROW[p] = r
    ws.cell(row=r, column=3, value=p).font = font(bold=True, color=PCOLOR[p])
    ws.cell(row=r, column=4, value=f'=Peso{p}').number_format = '0%'
    ws.cell(row=r, column=5, value=f'=IFERROR(SUMPRODUCT(($A$5:$A${last}=C{r})*ISNUMBER($U$5:$U${last}),$L$5:$L${last},$U$5:$U${last})/SUMPRODUCT(($A$5:$A${last}=C{r})*ISNUMBER($U$5:$U${last}),$L$5:$L${last}),0)').number_format = '0.0%'
    ws.cell(row=r, column=6, value=f'=IF(E{r}>=UmbralVerde,"Verde",IF(E{r}>=UmbralAmarillo,"Amarillo","Rojo"))')
    ws.cell(row=r, column=7, value=f'=D{r}*E{r}').number_format = '0.0%'
    ws.cell(row=r, column=8, value=f'=SUMIF($A$5:$A${last},C{r},$L$5:$L${last})').number_format = '0%'
gi = s0 + 6
ws.cell(row=gi, column=3, value='ÍNDICE GLOBAL').font = font(bold=True)
ws.cell(row=gi, column=5, value=f'=SUMPRODUCT(D{s0 + 2}:D{s0 + 5},E{s0 + 2}:E{s0 + 5})/SUM(D{s0 + 2}:D{s0 + 5})').number_format = '0.0%'
ws.cell(row=gi, column=5).font = font(bold=True, size=12)
ws.cell(row=gi, column=6, value=f'=IF(E{gi}>=UmbralVerde,"Verde",IF(E{gi}>=UmbralAmarillo,"Amarillo","Rojo"))')
srng = f'F{s0 + 2}:F{gi}'
for txt, col, fc in [('Verde', GREEN, 'FFFFFF'), ('Amarillo', AMBER, CARBON), ('Rojo', CORAL, 'FFFFFF')]:
    ws.conditional_formatting.add(srng, FormulaRule(formula=[f'F{s0 + 2}="{txt}"'], fill=fill(col), font=Font(color=fc, bold=True)))
name('IndiceGlobal', f'Indicadores!$E${gi}')
ws.freeze_panes = 'E5'
ws.cell(row=gi + 2, column=3, value='Cumplimiento: si la polaridad es ↑, real ÷ meta; si es ↓, meta ÷ real; con tope en TopeCumpl. Los indicadores sin dato del mes no cuentan en el promedio.').font = font(size=9, italic=True, color='666666')
IND_LAST = last

# ───────────────────────── Iniciativas ─────────────────────────
ws = ws_ini
title(ws, 'Iniciativas estratégicas', 'Amarillo = editable (fechas, presupuesto, gasto, avance). El Gantt y los semáforos se calculan solos.')
inits = [
    ('I1', 'Lanzar planes Pro y Premium con prueba gratis', 'F1, F2, C2', 'ene', 'mar', 4000, 3800, 1.0),
    ('I2', 'Panel de la barbería: CRM, ranking y punto de venta con boleta', 'C3, P3, F3', 'feb', 'jun', 12000, 10500, 0.85),
    ('I3', 'Programa de referidos entre barberías', 'C1', 'mar', 'may', 2000, 2300, 0.9),
    ('I4', 'Campañas con auspiciadores (kit comercial)', 'F3, C8, P6', 'abr', 'dic', 3000, 1100, 0.30),
    ('I5', 'Recordatorios y política de inasistencia', 'P2, C6', 'ene', 'feb', 800, 750, 1.0),
    ('I6', 'Academia del barbero (perfil y videos)', 'A1, A2', 'may', 'ago', 2500, 600, 0.20),
    ('I7', 'Membresías para clientes', 'F3, C6', 'jul', 'oct', 5000, 0, 0.0),
    ('I8', 'IA de recomendación de cortes, etapa 2', 'A5, C5', 'ago', 'dic', 6000, 0, 0.0),
]
hdr = ['Cód.', 'Iniciativa', 'Objetivos', 'Inicio', 'Fin', 'Presupuesto', 'Gasto real', 'Desviación', 'Avance real', 'Avance esperado', 'Estado'] + MESES + ['i_ini', 'i_fin']
header(ws, 4, 1, hdr, [6, 44, 12, 7, 7, 12, 12, 12, 10, 10, 11] + [5] * 12 + [5, 5])
ws.row_dimensions[4].height = 30
dvm = DataValidation(type='list', formula1='=ListaMeses'); ws.add_data_validation(dvm)
for i, (cod, nm, obj, ini, fin, pres, gasto, av) in enumerate(inits):
    r = 5 + i
    ws.cell(row=r, column=1, value=cod).font = font(bold=True)
    ws.cell(row=r, column=2, value=nm).font = font()
    ws.cell(row=r, column=3, value=obj).font = font()
    for col, v, fmt in [(4, ini, '@'), (5, fin, '@'), (6, pres, '"S/ "#,##0'), (7, gasto, '"S/ "#,##0'), (9, av, '0%')]:
        c = ws.cell(row=r, column=col, value=v); c.number_format = fmt; inp(c); c.border = BOX
    dvm.add(f'D{r}'); dvm.add(f'E{r}')
    ws.cell(row=r, column=8, value=f'=G{r}-F{r}').number_format = '"S/ "#,##0;[Red]-"S/ "#,##0'
    ws.cell(row=r, column=24, value=f'=MATCH(D{r},ListaMeses,0)')
    ws.cell(row=r, column=25, value=f'=MATCH(E{r},ListaMeses,0)')
    ws.cell(row=r, column=10, value=f'=MAX(0,MIN(1,(MesIdx-X{r}+1)/(Y{r}-X{r}+1)))').number_format = '0%'
    ws.cell(row=r, column=11, value=f'=IF(J{r}=0,"Por iniciar",IF(I{r}>=J{r},"Al día",IF(I{r}>=J{r}-0.15,"Leve atraso","Atrasada")))')
    for m in range(12):
        c = ws.cell(row=r, column=12 + m); c.border = BOX
    for col in range(1, 12):
        ws.cell(row=r, column=col).border = BOX
gl = 4 + len(inits)
ws.conditional_formatting.add(f'L5:W{gl}', FormulaRule(formula=['AND(COLUMN()-11>=$X5,COLUMN()-11<=$Y5,COLUMN()-11<=MesIdx)'], fill=fill(PETROL)))
ws.conditional_formatting.add(f'L5:W{gl}', FormulaRule(formula=['AND(COLUMN()-11>=$X5,COLUMN()-11<=$Y5)'], fill=fill('A9CFD3')))
ws.conditional_formatting.add(f'L4:W{gl}', FormulaRule(formula=['COLUMN()-11=MesIdx'], border=Border(left=Side(style='medium', color=GOLD), right=Side(style='medium', color=GOLD))))
for txt, col, fc in [('Al día', GREEN, 'FFFFFF'), ('Leve atraso', AMBER, CARBON), ('Atrasada', CORAL, 'FFFFFF'), ('Por iniciar', 'D9D6CE', CARBON)]:
    ws.conditional_formatting.add(f'K5:K{gl}', FormulaRule(formula=[f'K5="{txt}"'], fill=fill(col), font=Font(color=fc, bold=True)))
ws.column_dimensions['X'].hidden = True; ws.column_dimensions['Y'].hidden = True
dva = DataValidation(type='decimal', operator='between', formula1='0', formula2='1'); ws.add_data_validation(dva); dva.add(f'I5:I{gl}')
t = gl + 1
ws.cell(row=t, column=2, value='TOTAL').font = font(bold=True)
for col in (6, 7, 8):
    c = ws.cell(row=t, column=col, value=f'=SUM({L(col)}5:{L(col)}{gl})'); c.number_format = '"S/ "#,##0;[Red]-"S/ "#,##0'; c.font = font(bold=True)
ws.cell(row=t + 2, column=2, value='Gantt: azul oscuro = meses transcurridos del plan; azul claro = meses por venir; borde dorado = mes actual. Avance esperado = proporción del plazo transcurrido.').font = font(size=9, italic=True, color='666666')
ws.freeze_panes = 'C5'

# ───────────────────────── Mapa estratégico ─────────────────────────
ws = ws_map
title(ws, 'Mapa estratégico', '=CONCATENATE("Estado de cada objetivo en ",MesActual," ",AnioPlan," (promedio de cumplimiento de sus indicadores)")')
ws.sheet_view.showGridLines = False
for c in range(1, 22):
    ws.column_dimensions[L(c)].width = 9
ws.column_dimensions['A'].width = 16
objs = {}
for it in IND:
    objs.setdefault(it[0], [])
    if it[2] not in objs[it[0]]:
        objs[it[0]].append(it[2])
band_rows = {'Financiera': 5, 'Cliente': 10, 'Procesos': 15, 'Aprendizaje': 20}
OBJ_CELL = {}
for p, r0 in band_rows.items():
    for rr in range(r0 - 1, r0 + 3):
        for cc in range(1, 22):
            ws.cell(row=rr, column=cc).fill = fill('FBFAF6')
    lab = ws.cell(row=r0, column=1, value=p.upper()); lab.font = font(bold=True, color='FFFFFF', size=11)
    lab.fill = fill(PCOLOR[p]); lab.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    ws.merge_cells(start_row=r0, start_column=1, end_row=r0 + 1, end_column=1)
    lst = objs[p]
    for k, o in enumerate(lst):
        c0 = 2 + k * (20 // len(lst))
        span = max(2, 20 // len(lst) - 1)
        val = ws.cell(row=r0 + 2, column=c0, value=f'=IFERROR(AVERAGEIFS(Indicadores!$U$5:$U${IND_LAST},Indicadores!$C$5:$C${IND_LAST},"{o}"),"")')
        val.number_format = '0%'; val.font = font(size=8, color='888888')
        box = ws.cell(row=r0, column=c0, value=f'="{o}"&CHAR(10)&IF({L(c0)}{r0 + 2}="","sin dato",TEXT({L(c0)}{r0 + 2},"0%"))')
        box.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True); box.font = font(bold=True, size=9)
        ws.merge_cells(start_row=r0, start_column=c0, end_row=r0 + 1, end_column=c0 + span - 1)
        rng = f'{L(c0)}{r0}:{L(c0 + span - 1)}{r0 + 1}'
        ref = f'${L(c0)}${r0 + 2}'
        ws.conditional_formatting.add(rng, FormulaRule(formula=[f'AND(ISNUMBER({ref}),{ref}>=UmbralVerde)'], fill=fill(GREEN), font=Font(color='FFFFFF', bold=True)))
        ws.conditional_formatting.add(rng, FormulaRule(formula=[f'AND(ISNUMBER({ref}),{ref}>=UmbralAmarillo)'], fill=fill(AMBER), font=Font(color=CARBON, bold=True)))
        ws.conditional_formatting.add(rng, FormulaRule(formula=[f'ISNUMBER({ref})'], fill=fill(CORAL), font=Font(color='FFFFFF', bold=True)))
        ws.conditional_formatting.add(rng, FormulaRule(formula=['TRUE'], fill=fill('D9D6CE')))
        OBJ_CELL[o] = (r0, c0)
    ws.row_dimensions[r0].height = 26; ws.row_dimensions[r0 + 1].height = 26
for r0 in (8, 13, 18):
    for cc in range(2, 22, 3):
        a = ws.cell(row=r0 + 1, column=cc, value='▲'); a.font = font(color=GOLD, bold=True, size=14); a.alignment = Alignment(horizontal='center')
ws['A25'] = 'Relaciones causa → efecto (se leen de abajo hacia arriba)'; ws['A25'].font = font(bold=True, size=11)
chains = [
    'Profesionalizar al barbero (A1) → Digitalizar el local (P3) → Fidelizar usuarios (C6) → Diversificar ingresos (F3)',
    'Reservas eficientes (P2) → Calidad percibida (C7) → Retener barberías (C3) → Crecer ingresos recurrentes (F1)',
    'Uso de datos e IA (A5) → Atraer usuarios finales (C5) → Atraer auspiciadores (C8) → Diversificar ingresos (F3)',
    'Innovar el producto (A3) → Pagos confiables (P4) → Convertir a pago (C2) → Rentabilidad por cliente (F4, F5)',
    'Equipo capacitado (A6) → Soporte ágil (P7) → Satisfacer a la barbería (C4) → Retener barberías (C3)',
]
for i, ch in enumerate(chains):
    ws.cell(row=26 + i, column=1, value=f'{i + 1}.  {ch}').font = font(size=10)
ws['A32'] = 'Colores: verde ≥ umbral verde · ámbar ≥ umbral amarillo · coral = debajo · gris = sin dato del mes.'
ws['A32'].font = font(size=9, italic=True, color='666666')
ws.page_setup.orientation = 'landscape'; ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 1; ws.sheet_properties.pageSetUpPr.fitToPage = True

# ───────────────────────── Dashboard ─────────────────────────
ws = ws_dash
ws.sheet_view.showGridLines = False
ws.sheet_properties.tabColor = GOLD
for c in range(1, 26):
    ws.column_dimensions[L(c)].width = 8.5
ws['B1'] = 'CHARLES · Balanced Scorecard'; ws['B1'].font = font(size=20, bold=True, color=CARBON)
ws['B2'] = '=CONCATENATE("Tablero de ",MesActual," ",AnioPlan,"  ·  cambia el mes en Parámetros")'; ws['B2'].font = font(size=10, italic=True, color='666666')
ws['P1'] = 'Mes:'; ws['P1'].font = font(bold=True, size=12); ws['P1'].alignment = Alignment(horizontal='right')
ws['Q1'] = '=MesActual'; ws['Q1'].font = font(bold=True, size=14, color=GOLD)
# tarjetas
cards = [(p, 2 + 4 * k) for k, p in enumerate(PERSP)] + [('ÍNDICE GLOBAL', 18)]
for p, c0 in cards:
    is_g = p == 'ÍNDICE GLOBAL'
    col = CARBON if is_g else PCOLOR[p]
    width = 6 if is_g else 3
    for rr in range(4, 8):
        for cc in range(c0, c0 + width):
            ws.cell(row=rr, column=cc).fill = fill(col)
    h = ws.cell(row=4, column=c0, value=p.upper()); h.font = font(bold=True, color='FFFFFF', size=10)
    ws.merge_cells(start_row=4, start_column=c0, end_row=4, end_column=c0 + width - 1)
    if is_g:
        v = ws.cell(row=5, column=c0, value='=IndiceGlobal')
        st = f'=Indicadores!F{gi}'
        wt = '="Promedio ponderado de las 4 perspectivas"'
    else:
        v = ws.cell(row=5, column=c0, value=f'=Indicadores!E{PS_ROW[p]}')
        st = f'=Indicadores!F{PS_ROW[p]}'
        wt = f'="Peso "&TEXT(Peso{p},"0%")'
    v.number_format = '0%'; v.font = font(bold=True, color='FFFFFF', size=26); v.alignment = Alignment(horizontal='center', vertical='center')
    ws.merge_cells(start_row=5, start_column=c0, end_row=6, end_column=c0 + width - 1)
    s = ws.cell(row=7, column=c0, value=st); s.font = font(bold=True, color='FFFFFF', size=10); s.alignment = Alignment(horizontal='center')
    ws.merge_cells(start_row=7, start_column=c0, end_row=7, end_column=c0 + width - 1)
    w = ws.cell(row=8, column=c0, value=wt); w.font = font(size=8, color='666666'); w.alignment = Alignment(horizontal='center')
    ws.merge_cells(start_row=8, start_column=c0, end_row=8, end_column=c0 + width - 1)
    for txt, colr in [('Verde', GREEN), ('Amarillo', AMBER), ('Rojo', CORAL)]:
        ws.conditional_formatting.add(f'{L(c0)}7', FormulaRule(formula=[f'{L(c0)}7="{txt}"'], fill=fill(colr)))
ws.row_dimensions[5].height = 26; ws.row_dimensions[6].height = 26
# datos auxiliares (columnas ocultas a la derecha)
ws['AA3'] = 'Aux'
for j, p in enumerate(PERSP):
    ws.cell(row=4 + j, column=27, value=p)
    ws.cell(row=4 + j, column=28, value=f'=Indicadores!E{PS_ROW[p]}').number_format = '0%'
    ws.cell(row=4 + j, column=29, value='=UmbralVerde').number_format = '0%'
ws['AA9'] = 'Logrado'; ws['AB9'] = '=MIN(IndiceGlobal,1)'
ws['AA10'] = 'Brecha'; ws['AB10'] = '=MAX(0,1-IndiceGlobal)'
ws['AA12'] = 'Gratis'; ws['AB12'] = f'=INDEX({D}!${COL["gratis_fin"]}$5:${COL["gratis_fin"]}$16,MesIdx)'
ws['AA13'] = 'Pro'; ws['AB13'] = f'=INDEX({D}!${COL["pro_fin"]}$5:${COL["pro_fin"]}$16,MesIdx)'
ws['AA14'] = 'Premium'; ws['AB14'] = f'=INDEX({D}!${COL["prem_fin"]}$5:${COL["prem_fin"]}$16,MesIdx)'
for c in ['AA', 'AB', 'AC']:
    ws.column_dimensions[c].hidden = True

def chart_style(ch, t):
    ch.title = t; ch.style = 10; ch.height = 7.2; ch.width = 12.5; ch.legend.position = 'b'

bc = BarChart(); bc.type = 'bar'; chart_style(bc, 'Cumplimiento por perspectiva')
bc.add_data(Reference(ws, min_col=28, min_row=4, max_row=7), titles_from_data=False)
bc.set_categories(Reference(ws, min_col=27, min_row=4, max_row=7))
bc.series[0].graphicalProperties.solidFill = PETROL
bc.y_axis.number_format = '0%'; bc.y_axis.scaling.min = 0; bc.legend = None
bc.visible_cells_only = False
ws.add_chart(bc, 'B10')

dc = DoughnutChart(); dc.title = 'Índice global'; dc.height = 7.2; dc.width = 8.5; dc.holeSize = 60
dc.add_data(Reference(ws, min_col=28, min_row=9, max_row=10), titles_from_data=False)
dc.set_categories(Reference(ws, min_col=27, min_row=9, max_row=10))
from openpyxl.chart.series import DataPoint
for idx, colr in enumerate([GOLD, 'E6E2D8']):
    pt = DataPoint(idx=idx); pt.graphicalProperties.solidFill = colr; dc.series[0].dPt.append(pt)
dc.visible_cells_only = False
ws.add_chart(dc, 'J10')

fc = BarChart(); fc.type = 'bar'; chart_style(fc, 'Barberías al cierre del mes'); fc.width = 9.5
fc.add_data(Reference(ws, min_col=28, min_row=12, max_row=14), titles_from_data=False)
fc.set_categories(Reference(ws, min_col=27, min_row=12, max_row=14)); fc.legend = None
fc.series[0].graphicalProperties.solidFill = GOLD
fc.visible_cells_only = False
ws.add_chart(fc, 'P10')

lc = LineChart(); chart_style(lc, 'MRR real vs meta (S/)'); lc.width = 12.5
lc.add_data(Reference(ws_ten, min_col=2, max_col=15, min_row=AUX_MRR, max_row=AUX_MRR + 1), from_rows=True, titles_from_data=True)
lc.set_categories(Reference(ws_ten, min_col=4, max_col=15, min_row=base + 1))
lc.series[0].graphicalProperties.line.solidFill = GOLD; lc.series[0].graphicalProperties.line.width = 28000
lc.series[1].graphicalProperties.line.solidFill = CARBON; lc.series[1].graphicalProperties.line.dashStyle = 'dash'
lc.y_axis.number_format = '"S/ "#,##0'
lc.visible_cells_only = False
ws.add_chart(lc, 'B25')

# Remove the empty 2nd header column from the line series: rebuild refs explicitly
for s, rr in zip(lc.series, (AUX_MRR, AUX_MRR + 1)):
    s.val.numRef.f = f"Tendencias!$D${rr}:$O${rr}"

sc = BarChart(); sc.type = 'col'; sc.grouping = 'stacked'; sc.overlap = 100; chart_style(sc, 'Ingresos por fuente (S/)')
src_cols = ['ing_susc', 'ing_com', 'ing_ausp', 'ing_dest', 'ing_va']
for k, colr in zip(src_cols, [GOLD, PETROL, '5B5F97', GREEN, CORAL]):
    ci = list(COL).index(k) + 2
    sc.add_data(Reference(ws_dat, min_col=ci, min_row=4, max_row=16), titles_from_data=True)
    sc.series[-1].graphicalProperties.solidFill = colr
sc.set_categories(Reference(ws_dat, min_col=1, min_row=5, max_row=16))
sc.y_axis.number_format = '#,##0'; sc.legend.overlay = False; sc.legend.position = 'r'; sc.width = 15.5; sc.height = 8
ws.add_chart(sc, 'J25')

cc_ = LineChart(); chart_style(cc_, 'Churn mensual vs umbral'); cc_.width = 9.5
cc_.add_data(Reference(ws_ten, min_col=2, max_col=15, min_row=AUX_CHURN, max_row=AUX_CHURN + 1), from_rows=True, titles_from_data=True)
cc_.set_categories(Reference(ws_ten, min_col=4, max_col=15, min_row=base + 1))
for s, rr in zip(cc_.series, (AUX_CHURN, AUX_CHURN + 1)):
    s.val.numRef.f = f"Tendencias!$D${rr}:$O${rr}"
cc_.series[0].graphicalProperties.line.solidFill = CORAL
cc_.series[1].graphicalProperties.line.solidFill = CARBON; cc_.series[1].graphicalProperties.line.dashStyle = 'dash'
cc_.y_axis.number_format = '0%'
cc_.visible_cells_only = False
for s_ in cc_.series + lc.series:
    s_.smooth = False
ws.add_chart(cc_, 'T25')

for ch_ in (bc, fc, lc, sc, cc_):
    ch_.x_axis.delete = False; ch_.y_axis.delete = False

# Top 5 peores
t0 = 41
ws.cell(row=t0, column=2, value='Los 5 indicadores más lejos de su meta').font = font(bold=True, size=12)
header(ws, t0 + 1, 2, ['#', 'Cód.', 'Indicador', '', '', '', 'Cumplimiento', 'Semáforo'])
ws.merge_cells(start_row=t0 + 1, start_column=4, end_row=t0 + 1, end_column=7)
for k in range(1, 6):
    r = t0 + 1 + k
    ws.cell(row=r, column=2, value=k).font = font(bold=True)
    ws.cell(row=r, column=30, value=f'=LARGE(Indicadores!$V$5:$V${IND_LAST},B{r})')
    ws.cell(row=r, column=31, value=f'=MATCH(AD{r},Indicadores!$V$5:$V${IND_LAST},0)')
    ws.cell(row=r, column=3, value=f'=IF(AD{r}<0,"—",INDEX(Indicadores!$B$5:$B${IND_LAST},AE{r}))').font = font(bold=True)
    ws.cell(row=r, column=4, value=f'=IF(AD{r}<0,"",INDEX(Indicadores!$D$5:$D${IND_LAST},AE{r}))').font = font()
    ws.merge_cells(start_row=r, start_column=4, end_row=r, end_column=7)
    c = ws.cell(row=r, column=8, value=f'=IF(AD{r}<0,"",INDEX(Indicadores!$Q$5:$Q${IND_LAST},AE{r}))'); c.number_format = '0%'
    ws.cell(row=r, column=9, value=f'=IF(AD{r}<0,"",INDEX(Indicadores!$R$5:$R${IND_LAST},AE{r}))')
    for cc in range(2, 10):
        ws.cell(row=r, column=cc).border = BOX
for txt, colr in [('Verde', GREEN), ('Amarillo', AMBER), ('Rojo', CORAL)]:
    ws.conditional_formatting.add(f'I{t0 + 2}:I{t0 + 6}', FormulaRule(formula=[f'I{t0 + 2}="{txt}"'], fill=fill(colr), font=Font(bold=True, color='FFFFFF' if txt != 'Amarillo' else CARBON)))
ws.column_dimensions['AD'].hidden = True; ws.column_dimensions['AE'].hidden = True
# Estado de iniciativas
ws.cell(row=t0, column=12, value='Iniciativas').font = font(bold=True, size=12)
header(ws, t0 + 1, 12, ['Cód.', 'Iniciativa', '', '', '', '', 'Avance', 'Estado'])
ws.merge_cells(start_row=t0 + 1, start_column=13, end_row=t0 + 1, end_column=17)
for i in range(len(inits)):
    r = t0 + 2 + i; sr = 5 + i
    ws.cell(row=r, column=12, value=f'=Iniciativas!A{sr}').font = font(bold=True)
    ws.cell(row=r, column=13, value=f'=Iniciativas!B{sr}').font = font(size=9)
    ws.merge_cells(start_row=r, start_column=13, end_row=r, end_column=17)
    ws.cell(row=r, column=18, value=f'=Iniciativas!I{sr}').number_format = '0%'
    ws.cell(row=r, column=19, value=f'=Iniciativas!K{sr}')
    for cc in range(12, 20):
        ws.cell(row=r, column=cc).border = BOX
for txt, colr, fc in [('Al día', GREEN, 'FFFFFF'), ('Leve atraso', AMBER, CARBON), ('Atrasada', CORAL, 'FFFFFF'), ('Por iniciar', 'D9D6CE', CARBON)]:
    ws.conditional_formatting.add(f'S{t0 + 2}:S{t0 + 9}', FormulaRule(formula=[f'S{t0 + 2}="{txt}"'], fill=fill(colr), font=Font(color=fc, bold=True)))
ws.print_area = 'A1:Y51'
ws.page_setup.orientation = 'landscape'; ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 1; ws.sheet_properties.pageSetUpPr.fitToPage = True

# ───────────────────────── Inicio ─────────────────────────
ws = ws_inicio
ws.sheet_view.showGridLines = False
ws.column_dimensions['A'].width = 3; ws.column_dimensions['B'].width = 28; ws.column_dimensions['C'].width = 90
for rr in range(1, 5):
    for cc in range(1, 4):
        ws.cell(row=rr, column=cc).fill = fill(CARBON)
ws['B2'] = 'CHARLES'; ws['B2'].font = font(size=28, bold=True, color=GOLD)
ws['C2'] = 'Balanced Scorecard · Cuadro de Mando Integral'; ws['C2'].font = font(size=16, color='FFFFFF')
ws['C3'] = '=CONCATENATE("Plan ",AnioPlan,"  ·  mes analizado: ",MesActual)'; ws['C3'].font = font(size=10, color='DDDDDD')
rows = [
    ('Misión', 'Hacer crecer a las barberías del Perú con tecnología simple: más clientes, mejor gestión y una carrera digna para el barbero.'),
    ('Visión (2029)', 'Ser el sistema de gestión y reservas líder de barberías en el Perú.'),
    ('Estrategia', 'Freemium con penetración rápida → crecimiento por valor (subir barberías a Pro y Premium) → monetizar el ecosistema (auspiciadores).'),
]
for i, (k, v) in enumerate(rows):
    r = 6 + i
    ws.cell(row=r, column=2, value=k).font = font(bold=True, color=PETROL, size=11)
    c = ws.cell(row=r, column=3, value=v); c.font = font(size=10); c.alignment = Alignment(wrap_text=True)
    ws.row_dimensions[r].height = 30
ws['B10'] = 'Índice'; ws['B10'].font = font(bold=True, size=13)
idx = [('Parámetros', 'Mes, precios, pesos y umbrales'), (D, 'Datos de cada mes (se ingresan aquí)'),
       ('Indicadores', 'Los 28 indicadores con meta, cumplimiento y semáforo'), ('Mapa_Estrategico', 'Objetivos y relaciones causa-efecto'),
       ('Dashboard', 'Tablero del mes en una pantalla'), ('Iniciativas', 'Proyectos, presupuesto y Gantt'),
       ('Tendencias', 'Evolución mensual de cada indicador'), ('Glosario', 'Definiciones')]
for i, (sh, desc) in enumerate(idx):
    r = 11 + i
    c = ws.cell(row=r, column=2, value=f'→ {sh}'); c.hyperlink = f"#'{sh}'!A1"; c.font = font(color=PETROL, underline='single', bold=True)
    ws.cell(row=r, column=3, value=desc).font = font()
ws['B20'] = 'Cómo usarlo'; ws['B20'].font = font(bold=True, size=13)
steps = [
    '1. Al cerrar el mes, completa su fila en Datos_Mensuales (celdas amarillas). El ingreso por suscripciones se calcula solo.',
    '2. En Parámetros elige ese mes en "Mes actual". Todo el libro se actualiza: indicadores, semáforos, mapa y tablero.',
    '3. Revisa el Dashboard: tarjetas por perspectiva, índice global y los 5 indicadores más lejos de su meta.',
    '4. Para cambiar una meta, edítala en Indicadores (columna Meta). Para cambiar la importancia, ajusta los pesos (deben sumar 100 %).',
    '5. Actualiza el avance y el gasto de cada iniciativa en Iniciativas.',
    'Semáforo: verde = cumplimiento ≥ 100 % · ámbar = 80–99 % · coral = < 80 % (umbrales editables). Cumplimiento = real ÷ meta, o meta ÷ real si "menor es mejor".',
    'Celdas amarillas con texto azul = datos editables. El resto son fórmulas (hojas protegidas sin contraseña: Revisar → Desproteger hoja).',
    'Todas las cifras de ejemplo (ene–jun) y las metas son de demostración.',
]
for i, s in enumerate(steps):
    c = ws.cell(row=21 + i, column=2, value=s); c.font = font(size=10)
    ws.merge_cells(start_row=21 + i, start_column=2, end_row=21 + i, end_column=3)

# ───────────────────────── Glosario ─────────────────────────
ws = ws_glo
title(ws, 'Glosario')
ws.column_dimensions['A'].width = 18; ws.column_dimensions['B'].width = 100
gl_ = [
    ('BSC', 'Balanced Scorecard (Cuadro de Mando Integral, Kaplan y Norton): traduce la estrategia en objetivos e indicadores en cuatro perspectivas equilibradas.'),
    ('Perspectivas', 'Financiera, Cliente, Procesos internos y Aprendizaje y crecimiento. Se leen de abajo hacia arriba: el aprendizaje mejora los procesos, que satisfacen al cliente, que genera los resultados financieros.'),
    ('MRR', 'Monthly Recurring Revenue: ingreso mensual recurrente por suscripciones.'),
    ('ARPU', 'Average Revenue Per User: ingreso promedio por barbería de pago.'),
    ('CAC', 'Costo de adquisición de cliente: gasto de marketing y ventas ÷ nuevas barberías de pago.'),
    ('LTV', 'Lifetime Value: valor de vida de una barbería = ARPU × margen ÷ churn.'),
    ('Churn', 'Tasa de abandono: barberías de pago que cancelan o bajan a Gratis ÷ barberías de pago al inicio del mes.'),
    ('NPS', 'Net Promoter Score: % promotores (9–10) − % detractores (0–6). Va de −100 a +100.'),
    ('MAU', 'Monthly Active Users: usuarios con al menos una sesión en el mes.'),
    ('CTR', 'Click-Through Rate: clics ÷ impresiones de un anuncio.'),
    ('Freemium', 'Plan gratuito con funciones básicas y planes de pago con más capacidad y beneficios.'),
    ('Polaridad', '↑ mayor es mejor; ↓ menor es mejor. Define cómo se calcula el cumplimiento.'),
    ('Cumplimiento', 'Real ÷ meta (↑) o meta ÷ real (↓), con un tope para que un solo indicador no domine.'),
    ('Semáforo', 'Verde, ámbar o coral según el cumplimiento frente a los umbrales de Parámetros.'),
    ('Iniciativa', 'Proyecto que se ejecuta para mover uno o más objetivos.'),
]
header(ws, 3, 1, ['Término', 'Definición'])
for i, (k, v) in enumerate(gl_):
    ws.cell(row=4 + i, column=1, value=k).font = font(bold=True)
    c = ws.cell(row=4 + i, column=2, value=v); c.font = font(); c.alignment = Alignment(wrap_text=True)

# Protección (sin contraseña) y fuente por defecto
for s in [ws_par, ws_dat, ws_ind, ws_map, ws_dash, ws_ini, ws_ten, ws_glo, ws_inicio]:
    s.protection.sheet = True
    s.protection.formatColumns = False
    s.protection.formatRows = False
wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print('ok', OUT)
