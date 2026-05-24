'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useOPEDebugStore } from '@/lib/store/ope-debug-bridge';
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Minimize2,
  Maximize2,
  Activity,
  Brain,
  Link2,
  MessageSquare,
  Timer,
  Play,
  Heart,
  BarChart3,
  Settings,
  RefreshCw,
  Circle,
  CheckCircle,
  AlertCircle,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// SECCIONES DEL PANEL
// ============================================================================

const SECTIONS = [
  { id: 'session', label: 'Sesión', icon: Activity },
  { id: 'signals', label: 'Señales', icon: BarChart3 },
  { id: 'intent', label: 'Intent', icon: Brain },
  { id: 'decisions', label: 'Decisiones', icon: CheckCircle },
  { id: 'validity', label: 'Validez', icon: BarChart3 },
  { id: 'mobile', label: 'Mobile', icon: Activity },
  { id: 'memory', label: 'Memoria', icon: Brain },
  { id: 'relationships', label: 'Relaciones', icon: Link2 },
  { id: 'ranking', label: 'Ranking', icon: MessageSquare },
  { id: 'fatigue', label: 'Fatiga', icon: Timer },
  { id: 'lifecycle', label: 'Lifecycle', icon: Play },
  { id: 'trace', label: 'Trace', icon: Activity },
  { id: 'health', label: 'Salud', icon: Heart },
] as const;

// ============================================================================
// COMPONENTES DE SECCIÓN
// ============================================================================

function SessionSection() {
  const session = useOPEDebugStore(s => s.session);
  
  return (
    <div className="space-y-3">
      <DataRow label="Session ID" value={session.sessionId} mono />
      <DataRow label="Usuario" value={session.userId || 'Anónimo'} />
      <DataRow 
        label="Duración" 
        value={formatDuration(session.duration)} 
      />
      <DataRow label="Eventos" value={session.eventsCount.toString()} />
      <DataRow label="Revisitas" value={session.revisitCount.toString()} />
      <DataRow 
        label="Velocidad Scroll" 
        value={`${session.scrollVelocity.toFixed(1)} px/s`} 
      />
      <DataRow label="Contexto Activo" value={session.activeContext} highlight />
      <DataRow 
        label="Producto Activo" 
        value={session.activeProductId || 'Ninguno'} 
        mono 
      />
    </div>
  );
}

function SignalsSection() {
  const signals = useOPEDebugStore(s => s.signals);
  
  return (
    <div className="space-y-3">
      <SignalBar label="Hover" value={signals.hoverScore} />
      <SignalBar label="Dwell" value={signals.dwellScore} />
      <SignalBar label="Hesitación" value={signals.hesitationScore} color="yellow" />
      <SignalBar label="Interés" value={signals.interestScore} color="green" />
      <SignalBar label="Revisita" value={signals.revisitScore} />
      <SignalBar label="Confianza Carrito" value={signals.cartConfidence} color="green" />
      <SignalBar label="Confianza Completitud" value={signals.completionConfidence} color="blue" />
      <SignalBar label="Riesgo Devolución" value={signals.returnRisk} color="red" />
      <SignalBar label="Fatiga" value={signals.fatigueScore} color="orange" />
    </div>
  );
}

function IntentSection() {
  const intent = useOPEDebugStore(s => s.intent);
  
  return (
    <div className="space-y-3">
      <div className="p-2 rounded bg-muted/50">
        <div className="text-xs text-muted-foreground mb-1">Señales Raw</div>
        <div className="flex flex-wrap gap-1">
          {intent.rawSignals.length > 0 ? (
            intent.rawSignals.map((signal, i) => (
              <span key={i} className="px-1.5 py-0.5 text-xs bg-background rounded border">
                {signal}
              </span>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">Sin señales</span>
          )}
        </div>
      </div>
      
      <DataRow 
        label="Intent Actual" 
        value={intent.currentIntent} 
        highlight 
        badge={getIntentBadgeColor(intent.currentIntent)}
      />
      <DataRow 
        label="Confianza" 
        value={`${(intent.intentConfidence * 100).toFixed(0)}%`} 
      />
      <DataRow 
        label="Intent Anterior" 
        value={intent.previousIntent || 'N/A'} 
      />
      <DataRow 
        label="Razón Transición" 
        value={intent.transitionReason || 'N/A'} 
        mono 
      />
      <DataRow 
        label="Confianza Transición" 
        value={`${(intent.transitionConfidence * 100).toFixed(0)}%`} 
      />
    </div>
  );
}

// ── DecisionsSection: shows last decision with full context ─────────────────
function DecisionsSection() {
  const lastDecision  = useOPEDebugStore(s => s.lastDecision);
  const recentDecisions = useOPEDebugStore(s => s.recentDecisions);

  if (!lastDecision) {
    return (
      <div className="text-xs text-muted-foreground p-3 rounded bg-muted/40">
        Sin decisiones aún. Navega por la tienda para generar evaluaciones.
      </div>
    );
  }

  const decisionColor = (d: string) => {
    if (d === 'INTERVENE')     return 'text-green-500';
    if (d === 'DO_NOTHING')    return 'text-muted-foreground';
    if (d.startsWith('BLOCK')) return 'text-red-400';
    return 'text-yellow-400';
  };

  return (
    <div className="space-y-3">
      {/* Last decision — full detail */}
      <div className="p-3 rounded-md bg-muted/50 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Última Decisión</div>
        <DataRow label="Session ID"   value={lastDecision.sessionId}  mono />
        <DataRow
          label="Decisión"
          value={lastDecision.decision}
          highlight
        />
        <DataRow label="Confianza"    value={`${(lastDecision.confidence * 100).toFixed(0)}%`} />
        <DataRow label="Razón"        value={lastDecision.reason || '—'} />
        <DataRow label="Contexto"     value={lastDecision.context || '—'} />
        <DataRow label="Familia"      value={lastDecision.selectedFamily || '—'} />
        <DataRow label="Variante"     value={lastDecision.variant || '—'} />
        <DataRow label="Timestamp"    value={new Date(lastDecision.timestamp).toLocaleTimeString()} mono />
        {lastDecision.summary && (
          <div className="mt-2 text-xs text-muted-foreground bg-background rounded p-2 border">
            {lastDecision.summary}
          </div>
        )}
      </div>

      {/* Recent decisions log */}
      {recentDecisions.length > 1 && (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Historial Reciente</div>
          {recentDecisions.slice(1, 8).map((d, i) => (
            <div key={d.recordId || i} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-muted/30">
              <span className={decisionColor(d.decision)}>{d.decision}</span>
              <span className="text-muted-foreground">{d.context}</span>
              <span className="text-muted-foreground">{(d.confidence * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── MobileSection: shows inferred mobile intent and touch signals ─────────────
// ── StatisticalValiditySection ──────────────────────────────────────────────
// Displays the output of statistical-validity-engine.
// READ-ONLY: never modifies any engine state.
function ValiditySection() {
  const report = useOPEDebugStore(s => s.statisticalValidity);

  if (!report) {
    return (
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground p-3 rounded bg-muted/40">
          Sin datos de experimento. Asigna sesiones a grupos A/B para generar un reporte estadístico.
        </div>
        <div className="text-xs text-muted-foreground p-2">
          El motor de validez estadística usa ITT (Intent-to-Treat): compara
          <em> todos</em> los usuarios asignados, no solo los expuestos.
        </div>
      </div>
    );
  }

  const fmtPct  = (v: number | null) => v == null ? '—' : `${(v * 100).toFixed(2)}%`;
  const fmtNum  = (v: number | null, d = 4) => v == null ? '—' : v.toFixed(d);
  const fmtCI   = (ci: { lower: number | null; upper: number | null }) =>
    ci.lower == null ? '—' : `[${fmtNum(ci.lower)}, ${fmtNum(ci.upper)}]`;

  const verdictColor = report.significance
    ? 'text-green-500'
    : 'text-muted-foreground';

  const qualityColor = {
    high:   'text-green-500',
    medium: 'text-yellow-400',
    low:    'text-red-400',
  }[report.sampleQuality] ?? 'text-muted-foreground';

  const outlierSeverityColor = {
    none:   'text-green-500',
    low:    'text-yellow-400',
    medium: 'text-orange-400',
    high:   'text-red-400',
  }[report.outliers?.severity ?? 'none'] ?? 'text-muted-foreground';

  return (
    <div className="space-y-3">

      {/* Verdict — always first, never hidden */}
      <div className={`p-3 rounded-md border ${report.significance ? 'border-green-500/30 bg-green-500/5' : 'border-muted bg-muted/30'}`}>
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Veredicto</div>
        <div className={`text-sm font-medium ${verdictColor}`}>{report.verdict}</div>
        <div className="text-xs text-muted-foreground mt-1">
          Experimento: <span className="font-mono">{report.experimentId}</span>
        </div>
      </div>

      {/* Assignment & Exposure */}
      <div className="p-3 rounded-md bg-muted/50 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Asignación</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Asignados A</span>
          <span className="font-mono">{report.assignedA}</span>
          <span className="text-muted-foreground">Asignados B</span>
          <span className="font-mono">{report.assignedB}</span>
          <span className="text-muted-foreground">Expuestos A</span>
          <span className="font-mono">{report.exposedA}</span>
          <span className="text-muted-foreground">Expuestos B</span>
          <span className="font-mono">{report.exposedB}</span>
          <span className="text-muted-foreground">Ratio exposición</span>
          <span className="font-mono">{fmtNum(report.exposureRatio, 3)}</span>
        </div>
      </div>

      {/* ITT results */}
      <div className="p-3 rounded-md bg-muted/50 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">ITT (Intent-to-Treat)</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Conversión A</span>
          <span className="font-mono">{fmtPct(report.conversionRateA)}</span>
          <span className="text-muted-foreground">Conversión B</span>
          <span className="font-mono">{fmtPct(report.conversionRateB)}</span>
          <span className="text-muted-foreground">ITT Uplift</span>
          <span className={`font-mono font-medium ${report.ittUplift > 0 ? 'text-green-500' : report.ittUplift < 0 ? 'text-red-400' : ''}`}>
            {fmtNum(report.ittUplift, 4)}
          </span>
          <span className="text-muted-foreground">Uplift abs.</span>
          <span className="font-mono">{fmtPct(report.ittUpliftAbs)}</span>
        </div>
      </div>

      {/* Statistical tests */}
      <div className="p-3 rounded-md bg-muted/50 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tests estadísticos</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">IC 95%</span>
          <span className="font-mono text-[10px]">{fmtCI(report.ci95)}</span>
          <span className="text-muted-foreground">Median uplift</span>
          <span className="font-mono">{fmtNum(report.medianUplift, 4)}</span>
          <span className="text-muted-foreground">P-value</span>
          <span className={`font-mono ${report.pValue != null && report.pValue < 0.05 ? 'text-green-500' : ''}`}>
            {fmtNum(report.pValue, 4)}
          </span>
          <span className="text-muted-foreground">Effect size (h)</span>
          <span className="font-mono">{fmtNum(report.effectSize?.h, 4)}</span>
          <span className="text-muted-foreground">Interpretación</span>
          <span className="font-mono">{report.effectSize?.interpretation ?? '—'}</span>
        </div>
      </div>

      {/* Variance */}
      <div className="p-3 rounded-md bg-muted/50 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Varianza</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Varianza muestral</span>
          <span className="font-mono">{fmtNum(report.variance?.sampleVariance, 4)}</span>
          <span className="text-muted-foreground">Desv. estándar</span>
          <span className="font-mono">{fmtNum(report.variance?.standardDeviation, 4)}</span>
          <span className="text-muted-foreground">Coef. variación</span>
          <span className="font-mono">{fmtNum(report.variance?.coefficientOfVariation, 4)}</span>
        </div>
      </div>

      {/* Sample quality & outliers */}
      <div className="p-3 rounded-md bg-muted/50 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Calidad de muestra</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Calidad</span>
          <span className={`font-mono font-medium ${qualityColor}`}>{report.sampleQuality}</span>
          <span className="text-muted-foreground">Outliers (n)</span>
          <span className={`font-mono ${outlierSeverityColor}`}>{report.outliers?.count ?? 0}</span>
          <span className="text-muted-foreground">Severidad</span>
          <span className={`font-mono ${outlierSeverityColor}`}>{report.outliers?.severity ?? 'none'}</span>
        </div>
      </div>

      {/* Warnings */}
      {report.warnings && report.warnings.length > 0 && (
        <div className="p-3 rounded-md bg-yellow-500/10 border border-yellow-500/20 space-y-1">
          <div className="text-xs font-semibold text-yellow-500 uppercase tracking-wide">Advertencias</div>
          {report.warnings.map((w, i) => (
            <div key={i} className="text-xs text-yellow-400/90 leading-relaxed">{w}</div>
          ))}
        </div>
      )}

      {/* Methodology note — always visible */}
      <div className="p-2 rounded bg-muted/20 text-xs text-muted-foreground leading-relaxed">
        <span className="font-medium">Metodología: </span>
        ITT compara <em>todos</em> los asignados (no solo expuestos). Bootstrap 1000 muestras. Test de permutación 1000 iters. Cohen's h para effect size.
      </div>
    </div>
  );
}

function MobileSection() {
  const mobileIntent = useOPEDebugStore(s => s.mobileIntent);

  if (!mobileIntent) {
    return (
      <div className="text-xs text-muted-foreground p-3 rounded bg-muted/40">
        Sin señales mobile. Las señales táctiles aparecen en dispositivos touch.
      </div>
    );
  }

  const intentColor = (intent: string) => {
    if (intent === 'high_intent')  return 'text-green-500';
    if (intent === 'hesitating')   return 'text-yellow-400';
    if (intent === 'disengaged')   return 'text-red-400';
    return 'text-muted-foreground';
  };

  return (
    <div className="space-y-3">
      <div className="p-3 rounded-md bg-muted/50 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Mobile Intent</div>
        <DataRow label="Intent"    value={mobileIntent.intent} highlight />
        <DataRow label="Confianza" value={`${(mobileIntent.confidence * 100).toFixed(0)}%`} />
      </div>
      <div className="space-y-2">
        <SignalBar label="Thumb Zone" value={mobileIntent.thumbZoneRatio} />
        {mobileIntent.avgScrollVelocity != null && (
          <DataRow label="Scroll Vel." value={`${mobileIntent.avgScrollVelocity.toFixed(2)} px/ms`} mono />
        )}
        <DataRow label="Hesitando"    value={mobileIntent.isHesitating ? 'Sí' : 'No'} />
        <DataRow label="Long Press"   value={mobileIntent.hasLongPress ? 'Detectado' : 'No'} />
        <DataRow label="Toques"       value={mobileIntent.touchCount.toString()} />
      </div>
    </div>
  );
}

// ── MemorySection: shows user short-term and long-term memory state ──────────
function MemorySection() {
  const memoryState = useOPEDebugStore(s => s.memoryState);

  if (!memoryState) {
    return (
      <div className="text-xs text-muted-foreground p-3 rounded bg-muted/40">
        Sin datos de memoria. Interactúa con productos para generar memoria de sesión.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="p-3 rounded-md bg-muted/50 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Sesión Actual</div>
        <DataRow label="Productos ignorados" value={memoryState.ignoredProductCount.toString()} />
        <DataRow label="Dismissals"          value={memoryState.sessionDismissals.toString()} />
        <DataRow label="Hesitaciones"        value={memoryState.sessionHesitations.toString()} />
        <DataRow label="Revisitas"           value={memoryState.sessionRevisits.toString()} />
        <DataRow label="Adds al carrito"     value={memoryState.sessionCartAdds.toString()} />
      </div>
      {memoryState.topCategories.length > 0 && (
        <div className="p-3 rounded-md bg-muted/50 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Categorías Frecuentes</div>
          <div className="flex flex-wrap gap-1">
            {memoryState.topCategories.map(cat => (
              <span key={cat} className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary border border-primary/20">
                {cat}
              </span>
            ))}
          </div>
        </div>
      )}
      {memoryState.suppressedEntities.length > 0 && (
        <div className="p-3 rounded-md bg-destructive/10 space-y-1">
          <div className="text-xs font-semibold text-destructive uppercase tracking-wide">Entidades Suprimidas</div>
          {memoryState.suppressedEntities.map(e => (
            <div key={e} className="text-xs text-muted-foreground">{e}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function RelationshipsSection() {
  const relationships = useOPEDebugStore(s => s.relationships);
  
  if (relationships.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        Sin relaciones detectadas
      </div>
    );
  }
  
  return (
    <div className="space-y-3">
      {relationships.map((rel, i) => (
        <div key={i} className="p-2 rounded border bg-muted/30">
          <div className="flex justify-between items-start mb-2">
            <span className="text-xs font-mono">{rel.primaryId}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
              {rel.relationshipType}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            → {rel.complementId}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Confianza: </span>
              <span className={cn(
                rel.completionConfidence >= 0.85 ? 'text-green-500' : 'text-yellow-500'
              )}>
                {(rel.completionConfidence * 100).toFixed(0)}%
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Afinidad: </span>
              <span>{rel.historicalAffinity}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Neg. Pref: </span>
              <span className={rel.negativePreference ? 'text-red-500' : 'text-green-500'}>
                {rel.negativePreference ? 'Sí' : 'No'}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Score: </span>
              <span>{rel.relationshipScore.toFixed(2)}</span>
            </div>
          </div>
          {rel.suppressionState && (
            <div className="mt-2 text-xs text-red-500">
              Suprimido: {rel.suppressionState}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RankingSection() {
  const candidates = useOPEDebugStore(s => s.messageCandidates);
  
  if (candidates.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        Sin candidatos evaluados
      </div>
    );
  }
  
  return (
    <div className="space-y-2">
      {candidates.map((c, i) => (
        <div 
          key={c.id} 
          className={cn(
            "p-2 rounded border text-xs",
            c.selected ? "bg-green-500/10 border-green-500/50" : "bg-muted/30"
          )}
        >
          <div className="flex justify-between items-center mb-1">
            <span className="font-mono">{c.family}</span>
            <span className={cn(
              "px-1.5 py-0.5 rounded",
              c.selected ? "bg-green-500/20 text-green-500" : "bg-muted"
            )}>
              {(c.rankingScore * 100).toFixed(0)}
            </span>
          </div>
          <div className="text-muted-foreground truncate mb-1">
            {c.content}
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              Compat: {(c.compatibilityScore * 100).toFixed(0)}%
            </span>
            {c.rejectionReason && (
              <span className="text-red-500">{c.rejectionReason}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FatigueSection() {
  const fatigue = useOPEDebugStore(s => s.fatigue);
  
  return (
    <div className="space-y-3">
      <div className={cn(
        "p-2 rounded",
        fatigue.cooldownActive ? "bg-red-500/10 border border-red-500/30" : "bg-green-500/10 border border-green-500/30"
      )}>
        <div className="flex items-center gap-2">
          {fatigue.cooldownActive ? (
            <XCircle className="w-4 h-4 text-red-500" />
          ) : (
            <CheckCircle className="w-4 h-4 text-green-500" />
          )}
          <span className="text-sm">
            {fatigue.cooldownActive ? 'Cooldown Activo' : 'Sin Cooldown'}
          </span>
        </div>
        {fatigue.cooldownActive && (
          <div className="mt-1 text-xs text-muted-foreground">
            Restante: {formatDuration(fatigue.cooldownRemainingMs)}
          </div>
        )}
      </div>
      
      <DataRow label="Mensajes Sesión" value={fatigue.sessionMessagesCount.toString()} />
      <SignalBar label="Saturación" value={fatigue.saturationLevel} color="orange" />
      
      {fatigue.blockedReason && (
        <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-500">
          Bloqueado: {fatigue.blockedReason}
        </div>
      )}
      
      <div className="p-2 rounded bg-muted/50">
        <div className="text-xs text-muted-foreground mb-2">Fatiga por Familia</div>
        {Object.entries(fatigue.familyFatigue).length > 0 ? (
          <div className="space-y-1">
            {Object.entries(fatigue.familyFatigue).map(([family, value]) => (
              <div key={family} className="flex justify-between text-xs">
                <span>{family}</span>
                <span>{(value * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Sin datos</span>
        )}
      </div>
      
      <div className="p-2 rounded bg-muted/50">
        <div className="text-xs text-muted-foreground mb-2">Fatiga por Contexto</div>
        {Object.entries(fatigue.contextFatigue).length > 0 ? (
          <div className="space-y-1">
            {Object.entries(fatigue.contextFatigue).map(([ctx, value]) => (
              <div key={ctx} className="flex justify-between text-xs">
                <span>{ctx}</span>
                <span>{(value * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Sin datos</span>
        )}
      </div>
    </div>
  );
}

function LifecycleSection() {
  const lifecycle = useOPEDebugStore(s => s.lifecycle);
  
  const stateColors: Record<string, string> = {
    none: 'bg-muted text-muted-foreground',
    visible: 'bg-green-500/20 text-green-500',
    dismissed: 'bg-yellow-500/20 text-yellow-500',
    expired: 'bg-red-500/20 text-red-500',
    converted: 'bg-blue-500/20 text-blue-500',
  };
  
  return (
    <div className="space-y-3">
      <div className={cn(
        "p-3 rounded text-center",
        stateColors[lifecycle.state]
      )}>
        <div className="text-lg font-medium capitalize">{lifecycle.state}</div>
        {lifecycle.messageId && (
          <div className="text-xs mt-1 font-mono">{lifecycle.messageId}</div>
        )}
      </div>
      
      <div className="space-y-2">
        <DataRow 
          label="Mostrado" 
          value={lifecycle.shownAt ? formatTimestamp(lifecycle.shownAt) : 'N/A'} 
        />
        <DataRow 
          label="Descartado" 
          value={lifecycle.dismissedAt ? formatTimestamp(lifecycle.dismissedAt) : 'N/A'} 
        />
        <DataRow 
          label="Expirado" 
          value={lifecycle.expiredAt ? formatTimestamp(lifecycle.expiredAt) : 'N/A'} 
        />
      </div>
      
      {lifecycle.cleanupEvents.length > 0 && (
        <div className="p-2 rounded bg-muted/50">
          <div className="text-xs text-muted-foreground mb-2">Eventos de Limpieza</div>
          <div className="space-y-1">
            {lifecycle.cleanupEvents.map((evt, i) => (
              <div key={i} className="text-xs font-mono">{evt}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TraceSection() {
  const trace = useOPEDebugStore(s => s.trace);
  
  const stageOrder = [
    'listing', 'hover', 'dwell', 'revisit', 'product_detail',
    'add_to_cart', 'cart', 'cart_hesitation', 'checkout', 'post_purchase'
  ];
  
  if (trace.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        Sin transiciones registradas
      </div>
    );
  }
  
  return (
    <div className="space-y-2">
      {/* Timeline visual */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-2">
        {stageOrder.map((stage, i) => {
          const hasVisit = trace.some(t => t.stage === stage);
          return (
            <div key={stage} className="flex flex-col items-center min-w-[50px]">
              <div className={cn(
                "w-3 h-3 rounded-full",
                hasVisit ? "bg-primary" : "bg-muted"
              )} />
              <div className="text-[9px] text-muted-foreground mt-1 text-center">
                {stage.replace('_', '\n')}
              </div>
            </div>
          );
        })}
      </div>
      
      {/* Lista de transiciones */}
      <div className="space-y-1 max-h-[300px] overflow-y-auto">
        {trace.slice().reverse().map((entry) => (
          <div 
            key={entry.seq} 
            className={cn(
              "p-2 rounded border text-xs",
              entry.anomaly ? "border-red-500/50 bg-red-500/5" : "bg-muted/30"
            )}
          >
            <div className="flex justify-between items-center">
              <span className="font-mono">#{entry.seq}</span>
              <span className="text-muted-foreground">
                {formatTimestamp(entry.timestamp)}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-1">
              <span className="text-muted-foreground">{entry.prevStage || 'inicio'}</span>
              <span>→</span>
              <span className="font-medium">{entry.stage}</span>
            </div>
            {entry.productId && (
              <div className="text-muted-foreground mt-1">
                Producto: {entry.productId}
              </div>
            )}
            {entry.anomaly && (
              <div className="text-red-500 mt-1">
                Anomalía: {entry.anomaly}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HealthSection() {
  const health = useOPEDebugStore(s => s.health);
  
  return (
    <div className="space-y-3">
      <div className={cn(
        "p-3 rounded text-center",
        health.healthy ? "bg-green-500/10 border border-green-500/30" : "bg-red-500/10 border border-red-500/30"
      )}>
        {health.healthy ? (
          <CheckCircle className="w-8 h-8 mx-auto text-green-500" />
        ) : (
          <XCircle className="w-8 h-8 mx-auto text-red-500" />
        )}
        <div className="mt-2 font-medium">
          {health.healthy ? 'Sistema Saludable' : 'Problemas Detectados'}
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-2">
        <MetricCard 
          label="Memoria" 
          value={`${health.memoryUsage}%`}
          status={health.memoryUsage < 80 ? 'ok' : 'warn'}
        />
        <MetricCard 
          label="Refs Huérfanas" 
          value={health.orphanReferences.toString()}
          status={health.orphanReferences === 0 ? 'ok' : 'fail'}
        />
        <MetricCard 
          label="Timers Huérfanos" 
          value={health.orphanTimers.toString()}
          status={health.orphanTimers === 0 ? 'ok' : 'fail'}
        />
        <MetricCard 
          label="Listeners" 
          value={health.listenersCount.toString()}
          status="ok"
        />
      </div>
      
      <div className="space-y-1">
        <DataRow 
          label="Memoria Acotada" 
          value={health.boundedMemoryOk ? 'OK' : 'FALLA'}
          highlight={!health.boundedMemoryOk}
        />
        <DataRow 
          label="Replay Válido" 
          value={health.replayValid ? 'OK' : 'FALLA'}
          highlight={!health.replayValid}
        />
        <DataRow 
          label="Deriva de Estado" 
          value={health.stateDriftDetected ? 'DETECTADA' : 'No'}
          highlight={health.stateDriftDetected}
        />
      </div>
      
      {health.checks.length > 0 && (
        <div className="p-2 rounded bg-muted/50">
          <div className="text-xs text-muted-foreground mb-2">Checks Detallados</div>
          <div className="space-y-1">
            {health.checks.map((check, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <StatusDot status={check.status} />
                <span className="flex-1">{check.name}</span>
                {check.detail && (
                  <span className="text-muted-foreground truncate max-w-[100px]">
                    {check.detail}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// COMPONENTES AUXILIARES
// ============================================================================

function DataRow({ 
  label, 
  value, 
  mono, 
  highlight,
  badge,
}: { 
  label: string; 
  value: string; 
  mono?: boolean;
  highlight?: boolean;
  badge?: string;
}) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(
        mono && "font-mono text-xs",
        highlight && "text-primary font-medium",
        badge && `px-2 py-0.5 rounded ${badge}`
      )}>
        {value}
      </span>
    </div>
  );
}

function SignalBar({ 
  label, 
  value, 
  color = 'blue' 
}: { 
  label: string; 
  value: number;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'orange';
}) {
  const colorClasses = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
    orange: 'bg-orange-500',
  };
  
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span>{(value * 100).toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div 
          className={cn("h-full rounded-full transition-all duration-300", colorClasses[color])}
          style={{ width: `${value * 100}%` }}
        />
      </div>
    </div>
  );
}

function MetricCard({ 
  label, 
  value, 
  status 
}: { 
  label: string; 
  value: string;
  status: 'ok' | 'warn' | 'fail';
}) {
  const statusColors = {
    ok: 'border-green-500/30 bg-green-500/5',
    warn: 'border-yellow-500/30 bg-yellow-500/5',
    fail: 'border-red-500/30 bg-red-500/5',
  };
  
  return (
    <div className={cn("p-2 rounded border text-center", statusColors[status])}>
      <div className="text-lg font-medium">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function StatusDot({ status }: { status: 'pass' | 'warn' | 'fail' }) {
  const colors = {
    pass: 'bg-green-500',
    warn: 'bg-yellow-500',
    fail: 'bg-red-500',
  };
  
  return <div className={cn("w-2 h-2 rounded-full", colors[status])} />;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('es-CL', { 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit',
  });
}

function getIntentBadgeColor(intent: string): string {
  const colors: Record<string, string> = {
    exploring: 'bg-blue-500/20 text-blue-500',
    evaluating: 'bg-cyan-500/20 text-cyan-500',
    comparing: 'bg-purple-500/20 text-purple-500',
    hesitating: 'bg-yellow-500/20 text-yellow-500',
    high_intent: 'bg-green-500/20 text-green-500',
    purchase_ready: 'bg-emerald-500/20 text-emerald-500',
    disengaging: 'bg-orange-500/20 text-orange-500',
    exit_risk: 'bg-red-500/20 text-red-500',
    returning: 'bg-indigo-500/20 text-indigo-500',
  };
  return colors[intent] || 'bg-muted';
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export function OPEDebugPanel() {
  const {
    isPanelOpen,
    isPanelMinimized,
    panelWidth,
    activeSection,
    togglePanel,
    minimizePanel,
    setPanelWidth,
    setActiveSection,
    reset,
    events,
  } = useOPEDebugStore();
  
  const panelRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  
  // Resize handler
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);
  
  useEffect(() => {
    if (!isResizing) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      setPanelWidth(newWidth);
    };
    
    const handleMouseUp = () => {
      setIsResizing(false);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, setPanelWidth]);
  
  // Keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'd' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        togglePanel();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePanel]);
  
  // Render section content
  const renderSection = () => {
    switch (activeSection) {
      case 'session': return <SessionSection />;
      case 'signals': return <SignalsSection />;
      case 'intent': return <IntentSection />;
      case 'decisions': return <DecisionsSection />;
      case 'validity': return <ValiditySection />;
      case 'mobile': return <MobileSection />;
      case 'memory': return <MemorySection />;
      case 'relationships': return <RelationshipsSection />;
      case 'ranking': return <RankingSection />;
      case 'fatigue': return <FatigueSection />;
      case 'lifecycle': return <LifecycleSection />;
      case 'trace': return <TraceSection />;
      case 'health': return <HealthSection />;
      default: return <SessionSection />;
    }
  };
  
  // Botón flotante cuando está cerrado
  if (!isPanelOpen) {
    return (
      <button
        onClick={togglePanel}
        className="fixed left-4 bottom-4 z-50 p-3 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
        title="Abrir Panel de Debug OPE (Ctrl+Shift+D)"
      >
        <Bug className="w-5 h-5" />
      </button>
    );
  }
  
  return (
    <div
      ref={panelRef}
      className={cn(
        "fixed left-0 top-0 h-full z-50 bg-background border-r shadow-xl flex flex-col transition-all duration-200",
        isPanelMinimized && "w-12"
      )}
      style={{ width: isPanelMinimized ? 48 : panelWidth }}
    >
      {/* Resize handle */}
      {!isPanelMinimized && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-primary/50 transition-colors"
          onMouseDown={handleMouseDown}
        />
      )}
      
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b bg-muted/50">
        {!isPanelMinimized && (
          <div className="flex items-center gap-2">
            <Bug className="w-4 h-4 text-primary" />
            <span className="font-semibold text-sm">OPE Debug</span>
          </div>
        )}
        
        <div className="flex items-center gap-1">
          {!isPanelMinimized && (
            <button
              onClick={reset}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="Reiniciar"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={minimizePanel}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            title={isPanelMinimized ? "Expandir" : "Minimizar"}
          >
            {isPanelMinimized ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={togglePanel}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            title="Cerrar"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      </div>
      
      {!isPanelMinimized && (
        <>
          {/* Navigation tabs */}
          <div className="flex flex-wrap gap-1 p-2 border-b bg-muted/30">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
                  activeSection === id
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                )}
                title={label}
              >
                <Icon className="w-3 h-3" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          
          {/* Content */}
          <div className="flex-1 overflow-y-auto p-3">
            {renderSection()}
          </div>
          
          {/* Events footer */}
          <div className="border-t p-2 bg-muted/30">
            <div className="text-xs text-muted-foreground mb-2">
              Últimos eventos ({events.length})
            </div>
            <div className="space-y-1 max-h-[120px] overflow-y-auto">
              {events.slice(0, 5).map((event) => (
                <div 
                  key={event.id}
                  className={cn(
                    "flex items-center gap-2 text-xs p-1 rounded",
                    event.status === 'executed' && "bg-green-500/10",
                    event.status === 'blocked' && "bg-red-500/10",
                    event.status === 'waiting' && "bg-yellow-500/10",
                    event.status === 'active' && "bg-blue-500/10"
                  )}
                >
                  <Circle className={cn(
                    "w-2 h-2 fill-current",
                    event.status === 'executed' && "text-green-500",
                    event.status === 'blocked' && "text-red-500",
                    event.status === 'waiting' && "text-yellow-500",
                    event.status === 'active' && "text-blue-500"
                  )} />
                  <span className="font-mono">{event.type}</span>
                  <span className="text-muted-foreground ml-auto">
                    {formatTimestamp(event.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      
      {/* Minimized nav */}
      {isPanelMinimized && (
        <div className="flex flex-col gap-1 p-1">
          {SECTIONS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                setActiveSection(id);
                minimizePanel();
              }}
              className={cn(
                "p-2 rounded transition-colors",
                activeSection === id
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted"
              )}
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default OPEDebugPanel;
