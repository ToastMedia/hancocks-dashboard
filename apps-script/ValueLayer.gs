/**
 * ValueLayer.gs — the bit that makes this a product, not a data dump.
 *
 *  - Daily windowing from the Daily Trend tab (current vs previous period for
 *    ANY 7/30/90 window, not just the sheet's fixed 30-day columns).
 *  - Commercial Momentum Score (weighted index + %change + sparkline).
 *  - "So-What" insight header (rules-based plain-English summary).
 *
 * Design principle: lead with the headline number + direction + context.
 */

/** Percentage change cur vs prev. Returns null when prev is 0 (i.e. "New"). */
function pctChange_(cur, prev) {
  if (!prev) return cur > 0 ? null : 0; // null => caller shows "New"
  return (cur - prev) / prev;
}

/** A YYYY-MM-DD key in the spreadsheet's timezone. */
function dayKey_(d) {
  return Utilities.formatDate(d, getSpreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

/**
 * Build current/previous windows from Daily Trend.
 *
 * @param {number} windowDays 7 | 30 | 90
 * @return {{
 *   days: Array<{date:string, counts:Object, total:number, conversions:number, engagement:number}>,
 *   current: {sums:Object, total:number, conversions:number, engagement:number},
 *   previous:{sums:Object, total:number, conversions:number, engagement:number},
 *   maxDate: string
 * }}
 */
function getDailyWindows_(windowDays) {
  var rows = readDailyTrend_();
  var dateHeader = null;

  // Index rows by day key; find the most recent date present.
  var byDay = {};
  var maxDate = null;
  rows.forEach(function (row) {
    if (!dateHeader) {
      // First column is the date column whatever it's labelled.
      dateHeader = Object.keys(row)[0];
    }
    var d = toDate_(row[dateHeader]);
    if (!d) return;
    var key = dayKey_(d);
    byDay[key] = row;
    if (!maxDate || key > maxDate) maxDate = key;
  });

  function emptyAgg() {
    var sums = {};
    EVENTS.forEach(function (e) { sums[e.key] = 0; });
    return { sums: sums, total: 0, conversions: 0, engagement: 0 };
  }

  function addRowTo(agg, row) {
    EVENTS.forEach(function (e) {
      var v = toNum_(row[e.key]);
      agg.sums[e.key] += v;
      agg.total += v;
      if (e.type === 'conversion') agg.conversions += v; else agg.engagement += v;
    });
  }

  var current = emptyAgg();
  var previous = emptyAgg();
  var days = [];

  if (maxDate) {
    var end = new Date(maxDate + 'T00:00:00');
    // Current window: the windowDays days ending on maxDate (inclusive).
    for (var i = windowDays - 1; i >= 0; i--) {
      var d = new Date(end.getTime() - i * 86400000);
      var key = dayKey_(d);
      var row = byDay[key];
      var dayCounts = {};
      var dayTotal = 0, dayConv = 0, dayEng = 0;
      EVENTS.forEach(function (e) {
        var v = row ? toNum_(row[e.key]) : 0;
        dayCounts[e.key] = v;
        dayTotal += v;
        if (e.type === 'conversion') dayConv += v; else dayEng += v;
      });
      days.push({ date: key, counts: dayCounts, total: dayTotal, conversions: dayConv, engagement: dayEng });
      if (row) addRowTo(current, row);
    }
    // Previous window: the windowDays days immediately before that.
    for (var j = windowDays; j < windowDays * 2; j++) {
      var pd = new Date(end.getTime() - j * 86400000);
      var pkey = dayKey_(pd);
      var prow = byDay[pkey];
      if (prow) addRowTo(previous, prow);
    }
  }

  return { days: days, current: current, previous: previous, maxDate: maxDate };
}

/**
 * Commercial Momentum Score for the windows.
 * @return {{ current:number, previous:number, changePct:(number|null), sparkline:number[] }}
 */
function computeMomentum_(windows) {
  function score(sums) {
    var s = 0;
    EVENTS.forEach(function (e) {
      s += (sums[e.key] || 0) * (MOMENTUM_WEIGHTS[e.key] || 0);
    });
    return s;
  }
  var current = score(windows.current.sums);
  var previous = score(windows.previous.sums);
  var sparkline = windows.days.map(function (day) {
    var s = 0;
    EVENTS.forEach(function (e) { s += (day.counts[e.key] || 0) * (MOMENTUM_WEIGHTS[e.key] || 0); });
    return s;
  });
  return { current: current, previous: previous, changePct: pctChange_(current, previous), sparkline: sparkline };
}

/** Per-event current/previous/change, in canonical EVENTS order. */
function computeEventDeltas_(windows) {
  return EVENTS.map(function (e) {
    var cur = windows.current.sums[e.key] || 0;
    var prev = windows.previous.sums[e.key] || 0;
    return {
      key: e.key, label: e.label, type: e.type,
      current: cur, previous: prev, changePct: pctChange_(cur, prev)
    };
  });
}

/**
 * Rules-based "So-What" header: biggest mover, what's driving momentum, one
 * watch-out. Returns sentences (for display) + the structured signals behind
 * them (so the front end can style/badge without re-deriving anything).
 */
function computeSoWhat_(windows, momentum, deltas, funnel, windowDays) {
  var sentences = [];
  var signals = {};
  var label = windowDays + '-day';
  var prevLabel = 'the previous ' + windowDays + ' days';

  // 1) Momentum headline.
  if (momentum.changePct === null) {
    sentences.push('Commercial momentum is building from a standing start this ' + label + ' period.');
  } else {
    var dir = momentum.changePct >= 0 ? 'up' : 'down';
    sentences.push('Commercial momentum is ' + dir + ' ' + fmtPct_(momentum.changePct) +
      ' versus ' + prevLabel + ' (index ' + Math.round(momentum.current) + ').');
    signals.momentum = { dir: dir, changePct: momentum.changePct };
  }

  // 2) Biggest mover among conversion events (require a little volume).
  var movers = deltas.filter(function (d) {
    return d.type === 'conversion' && d.changePct !== null && (d.current + d.previous) >= 5;
  });
  movers.sort(function (a, b) { return Math.abs(b.changePct) - Math.abs(a.changePct); });
  if (movers.length) {
    var m = movers[0];
    var verb = m.changePct >= 0 ? 'rose' : 'fell';
    sentences.push('Biggest mover: ' + m.label + ' ' + verb + ' ' + fmtPct_(m.changePct) +
      ' (' + m.current + ' vs ' + m.previous + ').');
    signals.biggestMover = m;
  }

  // 3) Watch-out: a notable conversion drop, or a leaky enquiry->appointment funnel.
  var watch = null;
  if (funnel && funnel.enquiries >= 5 && funnel.conversionPct !== null && funnel.conversionPct < 0.2) {
    watch = 'Watch-out: only ' + fmtPct_(funnel.conversionPct) + ' of enquiries are converting to appointments — a funnel leak worth a look.';
    signals.watchOut = { type: 'funnel', value: funnel.conversionPct };
  } else {
    var drops = deltas.filter(function (d) {
      return d.type === 'conversion' && d.changePct !== null && d.changePct <= -0.2 && d.previous >= 5;
    });
    drops.sort(function (a, b) { return a.changePct - b.changePct; });
    if (drops.length && (!signals.biggestMover || drops[0].key !== signals.biggestMover.key || signals.biggestMover.changePct >= 0)) {
      watch = 'Watch-out: ' + drops[0].label + ' is down ' + fmtPct_(Math.abs(drops[0].changePct)) +
        ' on ' + prevLabel + '.';
      signals.watchOut = { type: 'drop', event: drops[0].key, value: drops[0].changePct };
    }
  }
  if (watch) sentences.push(watch);

  return { sentences: sentences, signals: signals };
}

/** Format a fraction as a signed/absolute percentage string. */
function fmtPct_(frac) {
  return Math.round(Math.abs(frac) * 100) + '%';
}
