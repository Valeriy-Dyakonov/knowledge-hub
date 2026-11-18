//! Spring Boot semantics over the Kotlin syntax model: beans, entry points, calls between beans and sinks.
//! Type resolution is heuristic (imports, same package, star imports); whatever cannot be resolved statically is
//! reported as an `UnresolvedFact` or left to Trace as INFERRED.
use super::syntax::{Annotation, Arg, Call, ClassKind, Function, KtClass, KtFile};
use crate::model::facts::*;
use crate::model::Evidence;
use std::collections::{BTreeMap, BTreeSet, HashMap};

const STEREOTYPES: [(&str, &str); 6] = [
    ("RestController", "CONTROLLER"),
    ("Controller", "CONTROLLER"),
    ("Service", "SERVICE"),
    ("Repository", "REPOSITORY"),
    ("Configuration", "CONFIGURATION"),
    ("Component", "COMPONENT"),
];
const REPOSITORY_BASES: [&str; 11] = [
    "JpaRepository", "CrudRepository", "PagingAndSortingRepository", "ListCrudRepository", "ListPagingAndSortingRepository",
    "ReactiveCrudRepository", "CoroutineCrudRepository", "MongoRepository", "R2dbcRepository", "JpaSpecificationExecutor", "Repository",
];
const MAPPINGS: [(&str, &str); 5] = [("GetMapping", "GET"), ("PostMapping", "POST"), ("PutMapping", "PUT"), ("DeleteMapping", "DELETE"), ("PatchMapping", "PATCH")];
const LISTENERS: [&str; 5] = ["KafkaListener", "RabbitListener", "JmsListener", "SqsListener", "EventListener"];
const WRITE_PREFIXES: [&str; 9] = ["save", "delete", "remove", "insert", "update", "persist", "merge", "flush", "truncate"];

/// Where evidence comes from: `(path, text)` of each file, to build fingerprints.
pub trait EvidenceSource {
    fn evidence(&self, path: &str, lines: (u32, u32)) -> Option<Evidence>;
}

struct Index<'a> {
    files: &'a [KtFile],
    /// fqn -> (file index, class)
    classes: HashMap<String, (usize, &'a KtClass)>,
    constants: BTreeMap<String, String>,
}

impl<'a> Index<'a> {
    fn new(files: &'a [KtFile]) -> Self {
        let mut classes = HashMap::new();
        let mut constants = BTreeMap::new();
        for (i, f) in files.iter().enumerate() {
            for c in &f.classes {
                classes.insert(c.fqn.clone(), (i, c));
            }
            for (k, v) in &f.constants {
                constants.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        Self { files, classes, constants }
    }

    /// Simple or qualified name as written in `file` -> FQN of a project class, or the name itself (library type).
    fn resolve(&self, name: &str, file: &KtFile) -> String {
        let name = name.trim_end_matches('?');
        if name.is_empty() {
            return String::new();
        }
        if self.classes.contains_key(name) {
            return name.to_string();
        }
        let (head, rest) = match name.split_once('.') {
            Some((h, r)) => (h, Some(r)),
            None => (name, None),
        };
        let with_rest = |base: String| match rest {
            Some(r) => format!("{base}.{r}"),
            None => base,
        };
        for imp in file.imports.iter().filter(|i| !i.star) {
            let simple = imp.alias.clone().unwrap_or_else(|| imp.fqn.rsplit('.').next().unwrap_or_default().to_string());
            if simple == head {
                return with_rest(imp.fqn.clone());
            }
        }
        let local = if file.package.is_empty() { head.to_string() } else { format!("{}.{head}", file.package) };
        if self.classes.contains_key(&with_rest(local.clone())) {
            return with_rest(local);
        }
        for imp in file.imports.iter().filter(|i| i.star) {
            let candidate = with_rest(format!("{}.{head}", imp.fqn));
            if self.classes.contains_key(&candidate) {
                return candidate;
            }
        }
        name.to_string()
    }

    fn is_project(&self, fqn: &str) -> bool {
        self.classes.contains_key(fqn)
    }

    fn constant(&self, reference: &str) -> Option<String> {
        self.constants.get(reference).cloned().or_else(|| {
            let mut parts = reference.rsplit('.');
            let last = parts.next()?;
            let owner = parts.next();
            owner.and_then(|o| self.constants.get(&format!("{o}.{last}")).cloned()).or_else(|| self.constants.get(last).cloned())
        })
    }
}

fn simple(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

fn is_repository_interface(class: &KtClass) -> bool {
    class.kind == ClassKind::Interface && class.supertypes.iter().any(|s| REPOSITORY_BASES.contains(&simple(&s.name)))
}

fn stereotype(class: &KtClass) -> Option<&'static str> {
    if class.annotation(&["FeignClient"]).is_some() {
        return Some("CLIENT");
    }
    if is_repository_interface(class) {
        return Some("REPOSITORY");
    }
    STEREOTYPES.iter().find(|(a, _)| class.annotation(&[a]).is_some()).map(|(_, k)| *k)
}

fn has_listener(class: &KtClass) -> bool {
    class.functions.iter().any(|f| f.annotations.iter().any(|a| LISTENERS.contains(&a.name.as_str())))
}

fn has_schedule(class: &KtClass) -> bool {
    class.functions.iter().any(|f| f.annotations.iter().any(|a| a.name == "Scheduled"))
}

/// Methods that run asynchronously: annotated `@Async`, or every method of an `@Async` class.
fn async_methods(class: &KtClass) -> Vec<&Function> {
    let whole = class.annotation(&["Async"]).is_some();
    class.functions.iter().filter(|f| whole || f.annotations.iter().any(|a| a.name == "Async")).collect()
}

fn join_path(prefix: &str, path: &str) -> String {
    let joined = format!("/{}/{}", prefix.trim_matches('/'), path.trim_matches('/'));
    let mut out = String::new();
    for seg in joined.split('/').filter(|s| !s.is_empty()) {
        out.push('/');
        out.push_str(seg);
    }
    if out.is_empty() { "/".into() } else { out }
}

/// Spring Boot default naming: `RefundEntity` -> `refund_entity`.
pub fn snake_case(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Tables named in a literal SQL statement, split into written and read ones.
pub fn sql_tables(sql: &str) -> (Vec<String>, Vec<String>) {
    let lower = sql.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| c.is_whitespace() || c == '(' || c == ',' || c == ';').filter(|w| !w.is_empty()).collect();
    let clean = |w: &str| w.trim_matches(|c| c == '"' || c == '`').to_string();
    let (mut write, mut read) = (Vec::new(), Vec::new());
    for (i, w) in words.iter().enumerate() {
        let next = words.get(i + 1).copied();
        match (*w, next) {
            ("into", Some(t)) if i > 0 && (words[i - 1] == "insert" || words[i - 1] == "merge") => write.push(clean(t)),
            ("update", Some(t)) if t != "set" => write.push(clean(t)),
            ("from", Some(t)) if i > 0 && words[i - 1] == "delete" => write.push(clean(t)),
            ("from", Some(t)) | ("join", Some(t)) if !t.starts_with("select") => read.push(clean(t)),
            _ => {}
        }
    }
    read.retain(|t| !write.contains(t));
    write.dedup();
    read.dedup();
    (write, read)
}

pub struct Analysis<'a> {
    index: Index<'a>,
    ev: &'a dyn EvidenceSource,
    facts: SourceFacts,
}

pub fn analyse(files: &[KtFile], ev: &dyn EvidenceSource) -> SourceFacts {
    let mut a = Analysis { index: Index::new(files), ev, facts: SourceFacts::default() };
    a.run();
    a.facts
}

struct Bean<'a> {
    file: &'a KtFile,
    class: &'a KtClass,
    kind: &'static str,
    /// field -> resolved type
    injected: BTreeMap<String, String>,
    /// field -> `${placeholder}` from @Value
    values: BTreeMap<String, String>,
}

impl<'a> Analysis<'a> {
    fn ev(&self, file: &KtFile, from: u32, to: u32) -> Option<Evidence> {
        self.ev.evidence(&file.path, (from, to.max(from)))
    }

    fn fn_ev(&self, file: &KtFile, f: &Function) -> Option<Evidence> {
        self.ev(file, f.start_line, f.signature_end_line)
    }

    fn run(&mut self) {
        for f in self.index.files {
            if let Some((first, _)) = f.parse_errors.first() {
                // "line 12: `companion object { val T = 1 }`; line 15: …" — parsed back by the UI for the report.
                let lines: Vec<String> = f.parse_errors.iter().take(10).map(|(l, near)| format!("line {l}: `{near}`")).collect();
                let ev = self.ev(f, *first, *first);
                self.facts.unresolved.push(UnresolvedFact { component_id: f.path.clone(), method: String::new(), reason: "PARSE_ERROR".into(), detail: lines.join("; "), evidence: ev });
            }
        }
        let beans = self.beans();
        for bean in &beans {
            self.component(bean);
        }
        for bean in &beans {
            self.triggers(bean);
            self.bodies(bean);
            if bean.kind == "CLIENT" {
                self.feign(bean);
            }
        }
        for bean in beans.iter().filter(|b| b.kind == "REPOSITORY" && is_repository_interface(b.class)) {
            self.repository(bean);
        }
    }

    fn beans(&self) -> Vec<Bean<'a>> {
        // @Bean factory methods make project classes beans even without a stereotype.
        let mut factory: BTreeSet<String> = BTreeSet::new();
        for f in self.index.files {
            for c in f.classes.iter().filter(|c| c.annotation(&["Configuration"]).is_some()) {
                for func in c.functions.iter().filter(|x| x.annotations.iter().any(|a| a.name == "Bean")) {
                    if let Some(rt) = &func.return_type {
                        let fqn = self.index.resolve(rt, f);
                        if self.index.is_project(&fqn) {
                            factory.insert(fqn);
                        }
                    }
                }
            }
        }
        let mut out = Vec::new();
        for f in self.index.files {
            for c in &f.classes {
                let kind = match stereotype(c) {
                    Some("COMPONENT") if has_listener(c) => "LISTENER",
                    Some(k) => k,
                    None if has_listener(c) => "LISTENER",
                    None if has_schedule(c) || factory.contains(&c.fqn) => "COMPONENT",
                    None => continue,
                };
                let mut injected = BTreeMap::new();
                let mut values = BTreeMap::new();
                for p in &c.constructor_params {
                    if let Some(v) = p.annotations.iter().find(|a| a.name == "Value").and_then(|a| a.values(&["value"]).into_iter().next()) {
                        values.insert(p.name.clone(), v);
                    } else if !p.type_name.is_empty() {
                        injected.insert(p.name.clone(), self.index.resolve(&p.type_name, f));
                    }
                }
                for p in &c.properties {
                    if let Some(v) = p.annotations.iter().find(|a| a.name == "Value").and_then(|a| a.values(&["value"]).into_iter().next()) {
                        values.insert(p.name.clone(), v);
                    } else if p.annotations.iter().any(|a| a.name == "Autowired" || a.name == "Inject") {
                        if let Some(t) = &p.type_name {
                            injected.insert(p.name.clone(), self.index.resolve(t, f));
                        }
                    }
                }
                out.push(Bean { file: f, class: c, kind, injected, values });
            }
        }
        out
    }

    fn component(&mut self, b: &Bean) {
        let mut attributes = BTreeMap::new();
        if b.kind == "REPOSITORY" {
            if let Some(table) = self.repository_table(b) {
                attributes.insert("table".into(), table);
            }
        }
        let asyncs: Vec<&str> = async_methods(b.class).iter().map(|f| f.name.as_str()).collect();
        if !asyncs.is_empty() {
            attributes.insert("async".into(), asyncs.join(","));
        }
        if let Some(a) = b.class.annotation(&["FeignClient"]) {
            if let Some(n) = a.values(&["name", "value"]).into_iter().next() {
                attributes.insert("feign.name".into(), n);
            }
            if let Some(u) = a.values(&["url"]).into_iter().next() {
                attributes.insert("feign.url".into(), u);
            }
        }
        let methods = b
            .class
            .functions
            .iter()
            .map(|f| MethodFact { name: f.name.clone(), parameter_types: f.params.iter().map(|p| self.index.resolve(&p.type_name, b.file)).collect(), evidence: self.ev(b.file, f.start_line, f.end_line) })
            .collect();
        let supertypes = b.class.supertypes.iter().map(|s| self.index.resolve(&s.name, b.file)).collect();
        self.facts.components.push(ComponentFact {
            id: b.class.fqn.clone(),
            simple_name: b.class.name.clone(),
            kind: b.kind.into(),
            is_interface: b.class.kind == ClassKind::Interface,
            supertypes,
            injected: b.injected.clone(),
            methods,
            attributes,
            evidence: self.ev(b.file, b.class.start_line, b.class.header_end_line),
        });
    }

    /// String literals of an annotation argument plus the values of referenced constants.
    fn ann_values(&self, a: &Annotation, names: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for arg in a.chosen(names) {
            out.extend(arg.strings.iter().cloned());
            out.extend(arg.refs.iter().filter_map(|r| self.index.constant(r)));
        }
        out
    }

    fn triggers(&mut self, b: &Bean) {
        let c = b.class;
        let is_controller = b.kind == "CONTROLLER";
        let prefixes = c.annotation(&["RequestMapping"]).map(|a| a.values(&["value", "path"])).filter(|v| !v.is_empty()).unwrap_or_else(|| vec![String::new()]);
        let mut found = Vec::new();
        for f in &c.functions {
            let ev = self.fn_ev(b.file, f);
            for a in &f.annotations {
                let mut push = |kind: &str, attrs: Vec<(&str, String)>| {
                    found.push(TriggerFact {
                        kind: kind.into(),
                        component_id: c.fqn.clone(),
                        method: f.name.clone(),
                        attributes: attrs.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
                        evidence: ev.clone(),
                    })
                };
                let http = MAPPINGS.iter().find(|(n, _)| *n == a.name).map(|(_, m)| vec![m.to_string()]).or_else(|| {
                    (a.name == "RequestMapping").then(|| {
                        let methods: Vec<String> = a.refs(&["method"]).iter().map(|r| simple(r).to_string()).collect();
                        if methods.is_empty() { vec!["ANY".to_string()] } else { methods }
                    })
                });
                if let Some(methods) = http {
                    if !is_controller {
                        continue;
                    }
                    let paths = a.values(&["value", "path"]);
                    let paths = if paths.is_empty() { vec![String::new()] } else { paths };
                    for prefix in &prefixes {
                        for p in &paths {
                            for m in &methods {
                                push("HTTP", vec![("httpMethod", m.clone()), ("path", join_path(prefix, p))]);
                            }
                        }
                    }
                    continue;
                }
                let (broker, keys): (&str, &[&str]) = match a.name.as_str() {
                    "KafkaListener" => ("kafka", &["topics", "value", "topicPattern"]),
                    "RabbitListener" => ("rabbit", &["queues", "value"]),
                    "JmsListener" => ("jms", &["destination", "value"]),
                    "SqsListener" => ("sqs", &["value", "queueNames"]),
                    _ => ("", &[]),
                };
                if !broker.is_empty() {
                    for d in self.ann_values(a, keys) {
                        push("MESSAGE", vec![("broker", broker.into()), ("destination", d)]);
                    }
                    continue;
                }
                match a.name.as_str() {
                    "Scheduled" => {
                        let mut attrs = Vec::new();
                        for key in ["cron", "fixedRate", "fixedDelay", "fixedRateString", "fixedDelayString"] {
                            let v = a.args.iter().find(|x| x.name.as_deref() == Some(key)).and_then(|x| x.strings.first().cloned().or_else(|| x.refs.first().cloned()));
                            if let Some(v) = v {
                                attrs.push((key.trim_end_matches("String"), v));
                            }
                        }
                        push("SCHEDULE", attrs);
                    }
                    "EventListener" | "TransactionalEventListener" => {
                        let declared = a.refs(&["classes", "value"]).into_iter().next();
                        let ty = declared.or_else(|| f.params.first().map(|p| p.type_name.clone())).map(|t| self.index.resolve(&t, b.file)).unwrap_or_default();
                        push("EVENT", vec![("eventType", ty)]);
                    }
                    _ => {}
                }
            }
        }
        self.facts.triggers.extend(found);
        // @Async methods run in their own thread. Discover decides whether one is an entry point of its own
        // (nobody in the project calls it) or a step of the calling flow.
        for f in async_methods(c) {
            self.facts.triggers.push(TriggerFact { kind: "ASYNC".into(), component_id: c.fqn.clone(), method: f.name.clone(), attributes: BTreeMap::new(), evidence: self.fn_ev(b.file, f) });
        }
        if c.supertypes.iter().any(|s| matches!(simple(&s.name), "ApplicationRunner" | "CommandLineRunner")) {
            if let Some(f) = c.functions.iter().find(|f| f.name == "run") {
                self.facts.triggers.push(TriggerFact {
                    kind: "STARTUP".into(),
                    component_id: c.fqn.clone(),
                    method: "run".into(),
                    attributes: BTreeMap::new(),
                    evidence: self.fn_ev(b.file, f),
                });
            }
        }
    }

    /// A destination argument as text: literal, constant, or `${placeholder}` of an @Value field.
    fn destination(&self, b: &Bean, arg: Option<&Arg>) -> Option<String> {
        let arg = arg?;
        if let Some(s) = &arg.string {
            return Some(s.clone());
        }
        let r = arg.reference.as_ref()?;
        b.values.get(r).cloned().or_else(|| self.index.constant(r))
    }

    fn bodies(&mut self, b: &Bean) {
        let own: BTreeSet<&str> = b.class.functions.iter().map(|f| f.name.as_str()).collect();
        for f in &b.class.functions {
            for call in &f.calls {
                let ev = self.ev(b.file, call.line, call.line);
                match &call.receiver {
                    None => {
                        if own.contains(call.method.as_str()) && call.method != f.name {
                            self.facts.calls.push(CallFact { from_component: b.class.fqn.clone(), from_method: f.name.clone(), target_type: b.class.fqn.clone(), target_method: call.method.clone(), evidence: ev });
                        }
                    }
                    Some(r) => {
                        let Some(ty) = b.injected.get(r) else { continue };
                        if self.index.is_project(ty) {
                            self.facts.calls.push(CallFact { from_component: b.class.fqn.clone(), from_method: f.name.clone(), target_type: ty.clone(), target_method: call.method.clone(), evidence: ev });
                        } else {
                            self.library_call(b, f, r, simple(ty), call, ev);
                        }
                    }
                }
            }
        }
    }

    fn sink(&mut self, b: &Bean, f: &Function, kind: &str, name: String, edge: &str, attrs: Vec<(&str, String)>, ev: Option<Evidence>) {
        self.facts.sink_accesses.push(SinkAccessFact {
            component_id: b.class.fqn.clone(),
            method: f.name.clone(),
            sink_kind: kind.into(),
            sink_name: name,
            edge_kind: edge.into(),
            origin: "STATIC".into(),
            confidence: "HIGH".into(),
            attributes: attrs.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
            evidence: ev,
        });
    }

    fn unresolved(&mut self, b: &Bean, f: &Function, reason: &str, detail: String, ev: Option<Evidence>) {
        self.facts.unresolved.push(UnresolvedFact { component_id: b.class.fqn.clone(), method: f.name.clone(), reason: reason.into(), detail, evidence: ev });
    }

    fn library_call(&mut self, b: &Bean, f: &Function, field: &str, ty: &str, call: &Call, ev: Option<Evidence>) {
        let m = call.method.as_str();
        let op = vec![("operation", m.to_string())];
        match ty {
            "KafkaTemplate" | "ReactiveKafkaProducerTemplate" if m == "send" || m == "sendDefault" => match self.destination(b, call.args.first()) {
                Some(t) => self.sink(b, f, "TOPIC", t, "PUBLISH", op, ev),
                None => self.unresolved(b, f, "UNRESOLVED_CALL", format!("{field}.{m}: dynamic topic"), ev),
            },
            "RabbitTemplate" | "AmqpTemplate" | "RabbitOperations" | "JmsTemplate" | "JmsOperations" if m == "convertAndSend" || m == "send" => {
                let parts: Vec<String> = call.args.iter().take(if call.args.len() >= 3 { 2 } else { 1 }).filter_map(|a| self.destination(b, Some(a))).collect();
                if parts.is_empty() {
                    self.unresolved(b, f, "UNRESOLVED_CALL", format!("{field}.{m}: dynamic destination"), ev);
                } else {
                    self.sink(b, f, "QUEUE", parts.join("/"), "PUBLISH", op, ev);
                }
            }
            "StreamBridge" if m == "send" => match self.destination(b, call.args.first()) {
                Some(binding) => self.sink(b, f, "TOPIC", format!("${{spring.cloud.stream.bindings.{binding}.destination:{binding}}}"), "PUBLISH", op, ev),
                None => self.unresolved(b, f, "UNRESOLVED_CALL", format!("{field}.{m}: dynamic binding"), ev),
            },
            "JdbcTemplate" | "NamedParameterJdbcTemplate" | "JdbcOperations" | "NamedParameterJdbcOperations" | "JdbcClient"
                if m.starts_with("query") || matches!(m, "update" | "batchUpdate" | "execute" | "sql") =>
            {
                match self.destination(b, call.args.first()) {
                    Some(sql) => {
                        let (write, read) = sql_tables(&sql);
                        for t in write {
                            self.sink(b, f, "DB_TABLE", t, "WRITE", op.clone(), ev.clone());
                        }
                        for t in read {
                            self.sink(b, f, "DB_TABLE", t, "READ", op.clone(), ev.clone());
                        }
                    }
                    None => self.unresolved(b, f, "DYNAMIC_SQL", format!("{field}.{m}"), ev),
                }
            }
            "RestTemplate" | "RestOperations" | "TestRestTemplate" => {
                let method = match m {
                    _ if m.starts_with("get") => "GET",
                    _ if m.starts_with("post") => "POST",
                    _ if m.starts_with("patch") => "PATCH",
                    "put" => "PUT",
                    "delete" => "DELETE",
                    "exchange" | "execute" => "ANY",
                    _ => return,
                };
                let url = self.destination(b, call.args.first());
                self.http(b, f, field, method, url, ev);
            }
            "WebClient" | "RestClient" => {
                let method = m.to_uppercase();
                if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "METHOD") {
                    return;
                }
                let uri = call.chain.iter().find(|(name, _)| name == "uri").and_then(|(_, args)| self.destination(b, args.first()));
                self.http(b, f, field, &method, uri, ev);
            }
            "ApplicationEventPublisher" | "ApplicationContext" if m == "publishEvent" => {
                let ty = call.args.first().and_then(|a| a.constructed.clone()).map(|t| self.index.resolve(&t, b.file));
                self.facts.events.push(EventPublishFact { component_id: b.class.fqn.clone(), method: f.name.clone(), event_type: ty, evidence: ev });
            }
            _ => {}
        }
    }

    /// External HTTP call: absolute URLs name the host; relative ones the client field (its base URL is configured elsewhere).
    fn http(&mut self, b: &Bean, f: &Function, field: &str, method: &str, url: Option<String>, ev: Option<Evidence>) {
        let (name, path) = match url {
            Some(u) if u.contains("://") => {
                let rest = u.split_once("://").map(|x| x.1).unwrap_or(&u);
                let (host, path) = rest.split_once('/').map(|(h, p)| (h.to_string(), format!("/{p}"))).unwrap_or((rest.to_string(), "/".into()));
                (host, path)
            }
            Some(u) if u.starts_with("${") => {
                let end = u.find('}').map(|i| i + 1).unwrap_or(u.len());
                (u[..end].to_string(), u[end..].to_string())
            }
            Some(u) => (field.to_string(), u),
            None => (field.to_string(), String::new()),
        };
        self.sink(b, f, "EXTERNAL_HTTP", name, "HTTP_CALL", vec![("httpMethod", method.to_string()), ("path", path), ("operation", f.name.clone())], ev);
    }

    fn feign(&mut self, b: &Bean) {
        let ann = b.class.annotation(&["FeignClient"]).unwrap();
        let name = ann.values(&["name", "value"]).into_iter().next().or_else(|| ann.values(&["url"]).into_iter().next()).unwrap_or_else(|| b.class.name.clone());
        for f in &b.class.functions {
            let Some((method, path)) = f.annotations.iter().find_map(|a| {
                let m = MAPPINGS.iter().find(|(n, _)| *n == a.name).map(|(_, m)| m.to_string()).or_else(|| (a.name == "RequestMapping").then(|| a.refs(&["method"]).first().map(|r| simple(r).to_string()).unwrap_or_else(|| "ANY".into())))?;
                Some((m, a.values(&["value", "path"]).into_iter().next().unwrap_or_default()))
            }) else { continue };
            let ev = self.fn_ev(b.file, f);
            self.sink(b, f, "EXTERNAL_HTTP", name.clone(), "HTTP_CALL", vec![("httpMethod", method), ("path", join_path("", &path)), ("operation", f.name.clone())], ev);
        }
    }

    fn repository_table(&self, b: &Bean) -> Option<String> {
        let base = b.class.supertypes.iter().find(|s| REPOSITORY_BASES.contains(&simple(&s.name)))?;
        let entity = self.index.resolve(base.args.first()?, b.file);
        let (_, class) = self.index.classes.get(&entity)?;
        let explicit = class
            .annotation(&["Table"])
            .and_then(|a| a.values(&["name", "value"]).into_iter().next())
            .or_else(|| class.annotation(&["Document"]).and_then(|a| a.values(&["collection", "value"]).into_iter().next()));
        Some(explicit.unwrap_or_else(|| snake_case(&class.name)))
    }

    /// Spring Data repository: every declared or called method becomes a READ/WRITE of the entity table.
    fn repository(&mut self, b: &Bean) {
        let Some(table) = self.repository_table(b) else {
            self.unresolved_class(b, "UNRESOLVED_CALL", "repository entity");
            return;
        };
        let mut methods: BTreeMap<String, Option<Evidence>> = BTreeMap::new();
        let mut writes: BTreeSet<String> = BTreeSet::new();
        for f in &b.class.functions {
            methods.insert(f.name.clone(), self.fn_ev(b.file, f));
            let modifying = f.annotations.iter().any(|a| a.name == "Modifying")
                || f.annotations.iter().find(|a| a.name == "Query").and_then(|a| a.values(&["value"]).into_iter().next()).is_some_and(|q| !sql_tables(&q).0.is_empty());
            if modifying {
                writes.insert(f.name.clone());
            }
        }
        let header = self.ev(b.file, b.class.start_line, b.class.header_end_line);
        let called: Vec<String> = self.facts.calls.iter().filter(|c| c.target_type == b.class.fqn).map(|c| c.target_method.clone()).collect();
        for m in called {
            methods.entry(m).or_insert_with(|| header.clone());
        }
        for (m, ev) in methods {
            let write = writes.contains(&m) || WRITE_PREFIXES.iter().any(|p| m.starts_with(p));
            self.facts.sink_accesses.push(SinkAccessFact {
                component_id: b.class.fqn.clone(),
                method: m.clone(),
                sink_kind: "DB_TABLE".into(),
                sink_name: table.clone(),
                edge_kind: if write { "WRITE" } else { "READ" }.into(),
                origin: "STATIC".into(),
                confidence: "HIGH".into(),
                attributes: [("operation".to_string(), m)].into(),
                evidence: ev,
            });
        }
    }

    fn unresolved_class(&mut self, b: &Bean, reason: &str, detail: &str) {
        let ev = self.ev(b.file, b.class.start_line, b.class.header_end_line);
        self.facts.unresolved.push(UnresolvedFact { component_id: b.class.fqn.clone(), method: String::new(), reason: reason.into(), detail: detail.into(), evidence: ev });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_tables_in_sql() {
        assert_eq!(sql_tables("update refunds set status = 'A' where id = ?"), (vec!["refunds".to_string()], vec![]));
        assert_eq!(sql_tables("INSERT INTO audit_log (x) SELECT y FROM refunds"), (vec!["audit_log".to_string()], vec!["refunds".to_string()]));
        assert_eq!(sql_tables("select * from a join b on a.id = b.id"), (vec![], vec!["a".to_string(), "b".to_string()]));
        assert_eq!(sql_tables("delete from refunds where id = ?"), (vec!["refunds".to_string()], vec![]));
    }

    #[test]
    fn names_tables_like_spring() {
        assert_eq!(snake_case("RefundEntity"), "refund_entity");
        assert_eq!(join_path("/api/v1/refunds", "/{id}"), "/api/v1/refunds/{id}");
        assert_eq!(join_path("", ""), "/");
    }
}
