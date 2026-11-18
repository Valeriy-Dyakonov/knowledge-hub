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
const REPOSITORY_BASES: [&str; 24] = [
    "JpaRepository", "CrudRepository", "PagingAndSortingRepository", "ListCrudRepository", "ListPagingAndSortingRepository",
    "ReactiveCrudRepository", "CoroutineCrudRepository", "CoroutineSortingRepository", "ReactiveSortingRepository",
    "MongoRepository", "ReactiveMongoRepository", "R2dbcRepository", "JpaSpecificationExecutor", "Repository",
    "KeyValueRepository", "ElasticsearchRepository", "ReactiveElasticsearchRepository", "CassandraRepository",
    "ReactiveCassandraRepository", "Neo4jRepository", "ReactiveNeo4jRepository", "CouchbaseRepository",
    "QuerydslPredicateExecutor", "RevisionRepository",
];
/// Spring Data / JPA templates that take the entity as an argument, with the store they write to.
const ENTITY_TEMPLATES: [(&str, &str); 15] = [
    ("R2dbcEntityTemplate", "sql"), ("R2dbcEntityOperations", "sql"), ("JdbcAggregateTemplate", "sql"),
    ("JdbcAggregateOperations", "sql"), ("EntityManager", "sql"), ("MongoTemplate", "mongo"),
    ("ReactiveMongoTemplate", "mongo"), ("MongoOperations", "mongo"), ("ReactiveMongoOperations", "mongo"),
    ("ElasticsearchOperations", "elasticsearch"), ("ElasticsearchTemplate", "elasticsearch"),
    ("ReactiveElasticsearchOperations", "elasticsearch"), ("CassandraTemplate", "cassandra"),
    ("ReactiveCassandraTemplate", "cassandra"), ("CassandraOperations", "cassandra"),
];
const TEMPLATE_WRITES: [&str; 13] = ["insert", "update", "delete", "save", "persist", "merge", "remove", "upsert", "findAndModify", "findAndRemove", "findAllAndRemove", "findAndReplace", "truncate"];
const TEMPLATE_READS: [&str; 10] = ["select", "selectOne", "find", "count", "exists", "getReference", "query", "aggregate", "search", "stream"];
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

/// A class with its file and the concrete types bound to its type parameters (empty for the bean itself).
struct Scope<'a> {
    class: &'a KtClass,
    file: &'a KtFile,
    types: HashMap<String, String>,
}

/// Declared type of a constructor parameter or property.
fn field_type(class: &KtClass, name: &str) -> Option<String> {
    class
        .constructor_params
        .iter()
        .find(|p| p.name == name)
        .map(|p| p.type_name.clone())
        .or_else(|| class.properties.iter().find(|p| p.name == name).and_then(|p| p.type_name.clone()))
        .filter(|t| !t.is_empty())
}

/// Type arguments of a `KClass<T>` / `Class<T>` field.
fn field_type_args(class: &KtClass, name: &str) -> Option<Vec<String>> {
    let (ty, args) = class
        .constructor_params
        .iter()
        .find(|p| p.name == name)
        .map(|p| (p.type_name.clone(), p.type_args.clone()))
        .or_else(|| class.properties.iter().find(|p| p.name == name).map(|p| (p.type_name.clone().unwrap_or_default(), p.type_args.clone())))?;
    matches!(simple(&ty), "KClass" | "Class").then_some(args)
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

/// `${key:default}` placeholders in a string: (key, default).
pub fn placeholders(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else { break };
        let inner = &after[..end];
        let (key, default) = match inner.split_once(':') {
            Some((k, d)) => (k.trim().to_string(), Some(d.to_string())),
            None => (inner.trim().to_string(), None),
        };
        if !key.is_empty() {
            out.push((key, default));
        }
        rest = &after[end + 1..];
    }
    out
}

/// Spring relaxed binding of a field: `maxAmount` -> `max-amount`.
pub fn kebab_case(name: &str) -> String {
    snake_case(name).replace('_', "-")
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
/// `RefundEvent` -> `refundEvent` (MongoDB's default collection name).
fn lower_first(name: &str) -> String {
    let mut c = name.chars();
    c.next().map(|f| f.to_lowercase().chain(c).collect()).unwrap_or_default()
}

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
        // One fact per error: the UI groups them by construct (`pattern`) and reports them without file names.
        for f in self.index.files {
            for e in f.parse_errors.iter().take(10) {
                let ev = self.ev(f, e.line, e.line);
                self.facts.unresolved.push(UnresolvedFact {
                    component_id: f.path.clone(),
                    method: String::new(),
                    reason: "PARSE_ERROR".into(),
                    detail: format!("line {}: `{}`", e.line, e.near),
                    attributes: {
                        let mut a = BTreeMap::from([
                            ("context".to_string(), e.context.clone()),
                            ("pattern".to_string(), e.pattern.clone()),
                            ("unparsed".to_string(), e.unparsed.clone()),
                            ("first".to_string(), e.first.to_string()),
                        ]);
                        if let Some((context, pattern)) = &e.inner {
                            a.insert("innerContext".into(), context.clone());
                            a.insert("innerPattern".into(), pattern.clone());
                        }
                        if let Some(d) = &e.diagnosis {
                            let map: serde_json::Map<String, serde_json::Value> = d.iter().map(|(k, v)| (k.clone(), v.clone().into())).collect();
                            a.insert("diagnosis".into(), serde_json::Value::Object(map).to_string());
                        }
                        a
                    },
                    evidence: ev,
                });
            }
        }
        let beans = self.beans();
        for bean in &beans {
            self.component(bean);
        }
        self.entities();
        self.config_usages(&beans);
        for bean in &beans {
            self.triggers(bean);
            self.bodies(bean);
            self.implicit_writes(bean);
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
        let bases = self.bases(b.class, b.file);
        // Template calls in inherited methods belong to this bean, with the base's type parameters bound.
        for (k, scope) in bases.iter().enumerate() {
            for f in &scope.class.functions {
                for call in &f.calls {
                    let Some(r) = &call.receiver else { continue };
                    let Some(ty) = field_type(scope.class, r) else { continue };
                    let Some(&(_, store)) = ENTITY_TEMPLATES.iter().find(|(t, _)| *t == simple(&ty)) else { continue };
                    let ev = self.ev(scope.file, call.line, call.line);
                    // The method's own class first, then the classes above it.
                    let scopes: Vec<Scope> = bases[k..].iter().map(|s| Scope { class: s.class, file: s.file, types: s.types.clone() }).collect();
                    self.template_access(&b.class.fqn, f, &scopes, store, call, ev);
                }
            }
        }
        let inherited: BTreeSet<&str> = bases.iter().flat_map(|s| s.class.functions.iter().map(|f| f.name.as_str())).collect();
        let own: BTreeSet<&str> = b.class.functions.iter().map(|f| f.name.as_str()).chain(inherited.iter().copied()).collect();
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

    /// Project superclasses of a class, nearest first, with their type parameters bound to the concrete types
    /// (`RefundDao : AbstractRepository<RefundEntity, UUID>` binds T -> RefundEntity).
    fn bases(&self, class: &'a KtClass, file: &'a KtFile) -> Vec<Scope<'a>> {
        let mut out = Vec::new();
        let (mut current, mut cfile, mut types) = (class, file, HashMap::<String, String>::new());
        for _ in 0..5 {
            let next = current.supertypes.iter().find_map(|s| {
                let fqn = self.index.resolve(&s.name, cfile);
                let &(i, c) = self.index.classes.get(&fqn)?;
                (c.kind == ClassKind::Class).then_some((s, i, c))
            });
            let Some((st, i, base)) = next else { break };
            let bound: HashMap<String, String> = base
                .type_params
                .iter()
                .zip(st.args.iter())
                .map(|(p, a)| (p.clone(), types.get(a).cloned().unwrap_or_else(|| self.index.resolve(a, cfile))))
                .collect();
            out.push(Scope { class: base, file: &self.index.files[i], types: bound.clone() });
            (current, cfile, types) = (base, &self.index.files[i], bound);
        }
        out
    }

    /// A call on an entity template (`template.insert(entity)`, `template.select(q, Foo::class.java)`,
    /// `em.createQuery("from Foo")`): the entity comes from the arguments, type parameters bound by `scope`.
    fn template_access(&mut self, component: &str, f: &Function, scopes: &[Scope], store: &str, call: &Call, ev: Option<Evidence>) {
        let m = call.method.as_str();
        let write = TEMPLATE_WRITES.iter().any(|w| m.starts_with(w));
        let read = TEMPLATE_READS.iter().any(|r| m.starts_with(r));
        let mut tables: Vec<(String, bool)> = Vec::new();
        if matches!(m, "createQuery" | "createNativeQuery") {
            if let Some(q) = call.args.first().and_then(|a| a.string.clone()) {
                let (w, r) = self.query_tables(&q, m == "createNativeQuery");
                tables.extend(w.into_iter().map(|t| (t, true)).chain(r.into_iter().map(|t| (t, false))));
            }
        } else if write || read {
            if let Some(entity) = call.args.iter().find_map(|a| self.arg_entity(a, f, scopes)) {
                tables.push((self.table_of(&entity, store), write));
            }
        }
        if tables.is_empty() && (write || read || m.starts_with("create")) {
            self.facts.unresolved.push(UnresolvedFact {
                component_id: component.to_string(),
                method: f.name.clone(),
                reason: "UNRESOLVED_CALL".into(),
                detail: format!("{m}: entity type not found"),
                attributes: BTreeMap::new(),
                evidence: ev,
            });
            return;
        }
        for (table, write) in tables {
            self.facts.sink_accesses.push(SinkAccessFact {
                component_id: component.to_string(),
                method: f.name.clone(),
                sink_kind: "DB_TABLE".into(),
                sink_name: table,
                edge_kind: if write { "WRITE" } else { "READ" }.into(),
                origin: "STATIC".into(),
                // Bound through a generic base: the type is right, the call may be overridden.
                confidence: if scopes[0].types.is_empty() { "HIGH" } else { "MEDIUM" }.into(),
                attributes: [("operation".to_string(), m.to_string())].into(),
                evidence: ev.clone(),
            });
        }
    }

    /// The entity an argument stands for: `Foo::class.java`, `Foo(...)`, a parameter typed `Foo` or `T`, a
    /// `KClass<T>`/`Class<T>` field (`kClazz.java`).
    fn arg_entity(&self, a: &Arg, f: &Function, scopes: &[Scope]) -> Option<String> {
        let bind = |s: &Scope, t: &str| s.types.get(t).cloned().unwrap_or_else(|| self.index.resolve(t, s.file));
        let project = |fqn: String| self.index.is_project(&fqn).then_some(fqn);
        let own = scopes.first()?;
        if let Some(c) = &a.constructed {
            return project(bind(own, c));
        }
        let r = a.reference.as_deref()?;
        let base = r.trim_end_matches(".java").trim_end_matches(".class").trim_end_matches(".kotlin");
        if let Some(p) = f.params.iter().find(|p| p.name == base) {
            return match simple(&p.type_name) {
                "KClass" | "Class" => p.type_args.first().and_then(|t| project(bind(own, t))),
                t => project(bind(own, t)),
            };
        }
        // `kClazz.java`: a KClass<T> field of this class or of a base, T bound in that base's scope.
        for s in scopes {
            if let Some(args) = field_type_args(s.class, base) {
                return args.first().and_then(|t| project(bind(s, t)));
            }
        }
        base.chars().next().filter(|c| c.is_uppercase()).and_then(|_| project(bind(own, base)))
    }

    /// Table (collection...) of an entity class: from its mapping, or the store's default name.
    fn table_of(&self, entity: &str, store: &str) -> String {
        if let Some(e) = self.facts.entities.iter().find(|e| e.id == entity) {
            return e.table.clone();
        }
        let via = match store {
            "mongo" => "MongoRepository",
            "elasticsearch" => "ElasticsearchRepository",
            "cassandra" => "CassandraRepository",
            _ => "R2dbcRepository",
        };
        self.index
            .classes
            .get(entity)
            .and_then(|&(i, c)| self.storage(c, &self.index.files[i], Some(via)))
            .map(|(_, name)| name)
            .unwrap_or_else(|| snake_case(simple(entity)))
    }

    /// JPA dirty checking: in a `@Transactional` (not read-only) method, an entity loaded through a repository and
    /// then changed (`e.status = …`) is written on commit without a `save`. Inferred, so it goes to review.
    fn implicit_writes(&mut self, b: &Bean) {
        let tx = |anns: &[Annotation]| anns.iter().find(|a| a.name == "Transactional").map(|a| a.refs(&["readOnly"]).iter().any(|r| r == "true"));
        let class_tx = tx(&b.class.annotations);
        for f in &b.class.functions {
            let Some(read_only) = tx(&f.annotations).or(class_tx) else { continue };
            if read_only {
                continue;
            }
            let mut done: BTreeSet<String> = BTreeSet::new();
            for (var, prop, line) in &f.assignments {
                let Some((_, Some((receiver, method)))) = f.locals.iter().rev().find(|(n, _)| n == var) else { continue };
                let Some(repo) = b.injected.get(receiver) else { continue };
                let Some(entity) = self.repository_entity(repo) else { continue };
                // Only JPA tracks loaded entities; Spring Data JDBC, MongoDB, Redis need an explicit save.
                let Some(e) = self.facts.entities.iter().find(|e| e.id == entity && e.store == "sql") else { continue };
                let jpa = self.index.classes.get(&entity).is_some_and(|(_, c)| c.annotation(&["Entity"]).is_some());
                if !jpa || !done.insert(e.table.clone()) {
                    continue;
                }
                let table = e.table.clone();
                let ev = self.ev(b.file, *line, *line);
                self.facts.sink_accesses.push(SinkAccessFact {
                    component_id: b.class.fqn.clone(),
                    method: f.name.clone(),
                    sink_kind: "DB_TABLE".into(),
                    sink_name: table,
                    edge_kind: "WRITE".into(),
                    origin: "INFERRED".into(),
                    confidence: "MEDIUM".into(),
                    attributes: [
                        ("operation".to_string(), format!("{var}.{prop} = …")),
                        ("implicit".to_string(), "dirtyChecking".to_string()),
                        ("loadedBy".to_string(), format!("{receiver}.{method}")),
                    ]
                    .into(),
                    evidence: ev,
                });
            }
        }
    }

    /// The entity type (FQN) of a Spring Data repository interface.
    fn repository_entity(&self, repo: &str) -> Option<String> {
        let &(i, class) = self.index.classes.get(repo)?;
        let base = class.supertypes.iter().find(|s| REPOSITORY_BASES.contains(&simple(&s.name)))?;
        Some(self.index.resolve(base.args.first()?, &self.index.files[i]))
    }

    /// Tables named in a `@Query`: native SQL as is; JPQL entity names (`from Refund r`) mapped to their tables.
    fn query_tables(&self, query: &str, native: bool) -> (Vec<String>, Vec<String>) {
        let (write, read) = sql_tables(query);
        if native {
            return (write, read);
        }
        let map = |names: Vec<String>| -> Vec<String> {
            names
                .into_iter()
                .filter(|n| !n.contains('.'))
                .filter_map(|n| {
                    self.facts.entities.iter().find(|e| simple(&e.id).eq_ignore_ascii_case(&n) || self.entity_name(&e.id).is_some_and(|x| x.eq_ignore_ascii_case(&n))).map(|e| e.table.clone())
                })
                .collect()
        };
        (map(write), map(read))
    }

    /// `@Entity(name = "X")`: the name JPQL uses instead of the class name.
    fn entity_name(&self, fqn: &str) -> Option<String> {
        let (_, c) = self.index.classes.get(fqn)?;
        c.annotation(&["Entity"]).and_then(|a| self.ann_value(a, &["name"]))
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
        self.facts.unresolved.push(UnresolvedFact { component_id: b.class.fqn.clone(), method: f.name.clone(), reason: reason.into(), detail, attributes: BTreeMap::new(), evidence: ev });
    }

    fn library_call(&mut self, b: &Bean, f: &Function, field: &str, ty: &str, call: &Call, ev: Option<Evidence>) {
        if let Some(&(_, store)) = ENTITY_TEMPLATES.iter().find(|(t, _)| *t == ty) {
            let mut scopes = vec![Scope { class: b.class, file: b.file, types: HashMap::new() }];
            scopes.extend(self.bases(b.class, b.file));
            self.template_access(&b.class.fqn, f, &scopes, store, call, ev);
            return;
        }
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
        let &(i, class) = self.index.classes.get(&entity)?;
        self.storage(class, &self.index.files[i], Some(simple(&base.name))).map(|(_, name)| name)
    }

    /// Spring Data repository: every declared or called method becomes a READ/WRITE of the entity table.
    fn repository(&mut self, b: &Bean) {
        let Some(table) = self.repository_table(b) else {
            self.unresolved_class(b, "UNRESOLVED_CALL", "repository entity");
            return;
        };
        let mut methods: BTreeMap<String, Option<Evidence>> = BTreeMap::new();
        let mut writes: BTreeSet<String> = BTreeSet::new();
        let mut joined: Vec<(String, String, bool)> = Vec::new();
        for f in &b.class.functions {
            methods.insert(f.name.clone(), self.fn_ev(b.file, f));
            let query = f.annotations.iter().find(|a| a.name == "Query");
            let text = query.and_then(|a| a.values(&["value"]).into_iter().next());
            let native = query.is_some_and(|a| a.refs(&["nativeQuery"]).iter().any(|r| r == "true"));
            let (qw, qr) = text.as_deref().map(|q| self.query_tables(q, native)).unwrap_or_default();
            let modifying = f.annotations.iter().any(|a| a.name == "Modifying") || text.as_deref().is_some_and(|q| !sql_tables(q).0.is_empty());
            if modifying {
                writes.insert(f.name.clone());
            }
            // Tables of the query other than the repository's own: joins, subqueries, updates of other tables.
            for (t, write) in qw.into_iter().map(|t| (t, true)).chain(qr.into_iter().map(|t| (t, false))) {
                if !t.eq_ignore_ascii_case(&table) {
                    joined.push((f.name.clone(), t, write));
                }
            }
        }
        for (m, t, write) in joined {
            let ev = methods.get(&m).cloned().flatten();
            self.facts.sink_accesses.push(SinkAccessFact {
                component_id: b.class.fqn.clone(),
                method: m.clone(),
                sink_kind: "DB_TABLE".into(),
                sink_name: t,
                edge_kind: if write { "WRITE" } else { "READ" }.into(),
                origin: "STATIC".into(),
                confidence: "HIGH".into(),
                attributes: [("operation".to_string(), m), ("via".to_string(), "@Query".to_string())].into(),
                evidence: ev,
            });
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

    /// JPA entities: table, columns (named by `@Column`/`@JoinColumn` or Spring's snake_case), keys, relations.
    /// Stored classes: JPA `@Entity`, Spring Data `@Table` (JDBC, R2DBC, Cassandra), `@Document` (MongoDB,
    /// Elasticsearch), `@RedisHash`, Neo4j `@Node`, and classes used as the type of a Spring Data repository.
    fn entities(&mut self) {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut found: Vec<(usize, &KtClass, &'static str, String)> = Vec::new();
        for (i, f) in self.index.files.iter().enumerate() {
            for c in &f.classes {
                if let Some((store, name)) = self.storage(c, f, None) {
                    seen.insert(c.fqn.clone());
                    found.push((i, c, store, name));
                }
            }
        }
        // Entity types of repositories, even without a mapping annotation (defaults of the repository's store).
        for f in self.index.files {
            for r in f.classes.iter().filter(|c| is_repository_interface(c)) {
                let Some(base) = r.supertypes.iter().find(|s| REPOSITORY_BASES.contains(&simple(&s.name))) else { continue };
                let Some(arg) = base.args.first() else { continue };
                let fqn = self.index.resolve(arg, f);
                if seen.contains(&fqn) {
                    continue;
                }
                let Some(&(i, c)) = self.index.classes.get(&fqn) else { continue };
                if let Some((store, name)) = self.storage(c, &self.index.files[i], Some(simple(&base.name))) {
                    seen.insert(fqn);
                    found.push((i, c, store, name));
                }
            }
        }
        for (i, c, store, table) in found {
            let f = &self.index.files[i];
            let fields = c
                .constructor_params
                .iter()
                .map(|p| (p.name.clone(), p.type_name.clone(), p.nullable, p.annotations.clone()))
                .chain(c.properties.iter().filter(|p| !p.modifiers.iter().any(|m| m == "const")).map(|p| (p.name.clone(), p.type_name.clone().unwrap_or_default(), p.nullable, p.annotations.clone())));
            let mut columns = Vec::new();
            for (name, ty, nullable, anns) in fields {
                let has = |n: &[&str]| anns.iter().any(|a| n.contains(&a.name.as_str()));
                if has(&["Transient", "OneToMany", "ManyToMany", "Embedded", "ElementCollection"]) {
                    continue;
                }
                let named = |ann: &str| anns.iter().find(|a| a.name == ann).and_then(|a| self.ann_value(a, &["name", "value"]));
                let relation = store == "sql" && has(&["ManyToOne", "OneToOne"]);
                let column = match store {
                    "sql" if relation => named("JoinColumn").unwrap_or_else(|| format!("{}_id", snake_case(&name))),
                    "sql" => named("Column").unwrap_or_else(|| snake_case(&name)),
                    "mongo" if has(&["Id", "MongoId"]) => "_id".to_string(),
                    "mongo" | "elasticsearch" => named("Field").unwrap_or_else(|| name.clone()),
                    "cassandra" => named("Column").or_else(|| named("PrimaryKeyColumn")).or_else(|| named("PrimaryKey")).unwrap_or_else(|| name.to_lowercase()),
                    "neo4j" => named("Property").unwrap_or_else(|| name.clone()),
                    _ => name.clone(),
                };
                columns.push(EntityColumnFact {
                    field: name,
                    column,
                    kotlin_type: ty.clone(),
                    nullable,
                    primary_key: has(&["Id", "EmbeddedId", "MongoId", "PrimaryKey", "PrimaryKeyColumn"]),
                    references_entity: relation.then(|| self.index.resolve(&ty, f)),
                });
            }
            let evidence = self.ev(f, c.start_line, c.header_end_line);
            self.facts.entities.push(EntityFact { id: c.fqn.clone(), store: store.into(), table, columns, evidence });
        }
    }

    /// First string value of an annotation argument; a constant reference is resolved.
    fn ann_value(&self, a: &Annotation, names: &[&str]) -> Option<String> {
        let v = a.values(names).into_iter().next()?;
        let is_ref = a.chosen(names).iter().all(|x| x.strings.is_empty());
        Some(if is_ref { self.index.constant(&v).unwrap_or(v) } else { v }).filter(|s| !s.is_empty())
    }

    /// Where a class is stored and under which name: by its mapping annotation, or — for the entity type of a
    /// repository (`via`) — by the repository's store. Imports tell apart the same annotation name in different
    /// Spring Data modules (`@Table`, `@Document`).
    fn storage(&self, c: &KtClass, f: &KtFile, via: Option<&str>) -> Option<(&'static str, String)> {
        let uses = |pkg: &str| f.imports.iter().any(|i| i.fqn.starts_with(pkg));
        if let Some(a) = c.annotation(&["RedisHash"]) {
            return Some(("redis", self.ann_value(a, &["value"]).unwrap_or_else(|| c.fqn.clone())));
        }
        if let Some(a) = c.annotation(&["Document"]) {
            if a.chosen(&["indexName"]).len() > 0 || uses("org.springframework.data.elasticsearch") {
                return Some(("elasticsearch", self.ann_value(a, &["indexName"]).unwrap_or_else(|| c.name.to_lowercase())));
            }
            return Some(("mongo", self.ann_value(a, &["collection", "value"]).unwrap_or_else(|| lower_first(&c.name))));
        }
        if let Some(a) = c.annotation(&["Node"]) {
            return Some(("neo4j", self.ann_value(a, &["labels", "primaryLabel", "value"]).unwrap_or_else(|| c.name.clone())));
        }
        let table = c.annotation(&["Table"]).and_then(|a| self.ann_value(a, &["name", "value"]));
        if c.annotation(&["Entity"]).is_some() {
            return Some(("sql", table.unwrap_or_else(|| snake_case(&c.name))));
        }
        if c.annotation(&["Table"]).is_some() {
            if uses("org.springframework.data.cassandra") {
                return Some(("cassandra", table.unwrap_or_else(|| c.name.to_lowercase())));
            }
            return Some(("sql", table.unwrap_or_else(|| snake_case(&c.name))));
        }
        let store = match via? {
            "MongoRepository" | "ReactiveMongoRepository" => "mongo",
            "ElasticsearchRepository" | "ReactiveElasticsearchRepository" => "elasticsearch",
            "CassandraRepository" | "ReactiveCassandraRepository" => "cassandra",
            "Neo4jRepository" | "ReactiveNeo4jRepository" => "neo4j",
            "KeyValueRepository" => "redis",
            "JpaRepository" | "JpaSpecificationExecutor" | "R2dbcRepository" | "RevisionRepository" => "sql",
            _ => "unknown",
        };
        let name = match store {
            "mongo" => lower_first(&c.name),
            "redis" => c.fqn.clone(),
            "elasticsearch" | "cassandra" => c.name.to_lowercase(),
            "neo4j" => c.name.clone(),
            _ => snake_case(&c.name),
        };
        Some((store, name))
    }

    /// Where code reads configuration: `@Value`, placeholders in annotations, `@ConfigurationProperties` (and the
    /// beans that inject them), `Environment.getProperty`.
    fn config_usages(&mut self, beans: &[Bean]) {
        let mut out: Vec<ConfigUsageFact> = Vec::new();
        let usage = |key: String, component: &str, method: Option<String>, kind: &str, default: Option<String>, evidence: Option<Evidence>| ConfigUsageFact {
            key, component_id: component.to_string(), method, kind: kind.into(), default, evidence,
        };
        // @ConfigurationProperties classes: the prefix and each field of it.
        let mut prefixes: BTreeMap<String, String> = BTreeMap::new();
        for f in self.index.files {
            for c in f.classes.iter() {
                let Some(prefix) = c.annotation(&["ConfigurationProperties"]).and_then(|a| a.values(&["prefix", "value"]).into_iter().next()) else { continue };
                prefixes.insert(c.fqn.clone(), prefix.clone());
                let ev = self.ev(f, c.start_line, c.header_end_line);
                out.push(usage(format!("{prefix}.*"), &c.fqn, None, "properties", None, ev.clone()));
                for p in c.constructor_params.iter().map(|p| p.name.clone()).chain(c.properties.iter().map(|p| p.name.clone())) {
                    out.push(usage(format!("{prefix}.{}", kebab_case(&p)), &c.fqn, None, "properties", None, ev.clone()));
                }
            }
        }
        for b in beans {
            let header = self.ev(b.file, b.class.start_line, b.class.header_end_line);
            for v in b.values.values() {
                for (key, default) in placeholders(v) {
                    out.push(usage(key, &b.class.fqn, None, "value", default, header.clone()));
                }
            }
            for a in &b.class.annotations {
                for s in a.args.iter().flat_map(|x| x.strings.iter()) {
                    for (key, default) in placeholders(s) {
                        out.push(usage(key, &b.class.fqn, None, "annotation", default, header.clone()));
                    }
                }
            }
            for f in &b.class.functions {
                let fev = self.fn_ev(b.file, f);
                for a in &f.annotations {
                    for s in a.args.iter().flat_map(|x| x.strings.iter()) {
                        for (key, default) in placeholders(s) {
                            out.push(usage(key, &b.class.fqn, Some(f.name.clone()), "annotation", default, fev.clone()));
                        }
                    }
                }
                for call in &f.calls {
                    let env = call.receiver.as_ref().and_then(|r| b.injected.get(r)).is_some_and(|t| simple(t) == "Environment");
                    if env && matches!(call.method.as_str(), "getProperty" | "getRequiredProperty" | "containsProperty") {
                        if let Some(key) = call.args.first().and_then(|a| a.string.clone()) {
                            let default = call.args.get(1).and_then(|a| a.string.clone());
                            out.push(usage(key, &b.class.fqn, Some(f.name.clone()), "environment", default, self.ev(b.file, call.line, call.line)));
                        }
                    }
                }
            }
            // A bean that injects a @ConfigurationProperties class depends on its whole prefix.
            for ty in b.injected.values() {
                if let Some(prefix) = prefixes.get(ty) {
                    out.push(usage(format!("{prefix}.*"), &b.class.fqn, None, "properties", None, header.clone()));
                }
            }
        }
        self.facts.config_usages.extend(out);
    }

    fn unresolved_class(&mut self, b: &Bean, reason: &str, detail: &str) {
        let ev = self.ev(b.file, b.class.start_line, b.class.header_end_line);
        self.facts.unresolved.push(UnresolvedFact { component_id: b.class.fqn.clone(), method: String::new(), reason: reason.into(), detail: detail.into(), attributes: BTreeMap::new(), evidence: ev });
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
    fn reads_placeholders() {
        assert_eq!(placeholders("${a.b}"), vec![("a.b".to_string(), None)]);
        assert_eq!(placeholders("x ${a:1} ${b.c:0 0 * * * *}"), vec![("a".to_string(), Some("1".to_string())), ("b.c".to_string(), Some("0 0 * * * *".to_string()))]);
        assert_eq!(kebab_case("maxAmount"), "max-amount");
    }

    #[test]
    fn names_tables_like_spring() {
        assert_eq!(snake_case("RefundEntity"), "refund_entity");
        assert_eq!(join_path("/api/v1/refunds", "/{id}"), "/api/v1/refunds/{id}");
        assert_eq!(join_path("", ""), "/");
    }
}
