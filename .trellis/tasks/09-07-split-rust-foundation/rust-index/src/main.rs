use quote::ToTokens;
use serde_json::json;
use syn::{spanned::Spanned, Item};

fn identifiers(tokens: proc_macro2::TokenStream, names: &mut std::collections::BTreeSet<String>) {
    for token in tokens {
        match token {
            proc_macro2::TokenTree::Ident(value) => { names.insert(value.to_string()); },
            proc_macro2::TokenTree::Group(group) => identifiers(group.stream(), names),
            _ => {}
        }
    }
}

fn use_names(tree: &syn::UseTree, names: &mut Vec<String>) {
    match tree {
        syn::UseTree::Name(value) => names.push(value.ident.to_string()),
        syn::UseTree::Rename(value) => names.push(value.rename.to_string()),
        syn::UseTree::Path(value) => {
            if let syn::UseTree::Name(leaf) = value.tree.as_ref() {
                if leaf.ident == "self" { names.push(value.ident.to_string()); return; }
            }
            use_names(&value.tree, names);
        },
        syn::UseTree::Group(value) => { for item in &value.items { use_names(item, names); } },
        syn::UseTree::Glob(_) => {}
    }
}

fn main() {
    let mut reports = Vec::new();
    for file in std::env::args().skip(1) {
        let source = std::fs::read_to_string(&file).expect("source readable");
        let parsed = syn::parse_file(&source).expect("valid Rust file");
        let items: Vec<_> = parsed.items.iter().map(|item| {
            let (kind, name, visibility) = match item {
                Item::Fn(value) => ("fn", value.sig.ident.to_string(), value.vis.to_token_stream().to_string()),
                Item::Struct(value) => ("struct", value.ident.to_string(), value.vis.to_token_stream().to_string()),
                Item::Enum(value) => ("enum", value.ident.to_string(), value.vis.to_token_stream().to_string()),
                Item::Impl(value) => ("impl", value.self_ty.to_token_stream().to_string(), String::new()),
                Item::Mod(value) => ("mod", value.ident.to_string(), value.vis.to_token_stream().to_string()),
                Item::Const(value) => ("const", value.ident.to_string(), value.vis.to_token_stream().to_string()),
                Item::Static(value) => ("static", value.ident.to_string(), value.vis.to_token_stream().to_string()),
                Item::Type(value) => ("type", value.ident.to_string(), value.vis.to_token_stream().to_string()),
                Item::Use(_) => ("use", String::new(), String::new()),
                _ => ("other", String::new(), String::new()),
            };
            let mut refs = std::collections::BTreeSet::new();
            identifiers(item.to_token_stream(), &mut refs);
            let mut bindings = Vec::new();
            if let Item::Use(value) = item { use_names(&value.tree, &mut bindings); }
            let mut members = Vec::new();
            if let Item::Impl(value) = item {
                if value.trait_.is_none() {
                    for member in &value.items {
                        if let syn::ImplItem::Fn(method) = member {
                            members.push(json!({"name": method.sig.ident.to_string(), "visibility": method.vis.to_token_stream().to_string(), "line": method.sig.fn_token.span.start().line}));
                        }
                    }
                }
            }
            let fields: Vec<_> = if let Item::Struct(value) = item {
                value.fields.iter().map(|field| json!({"name": field.ident.as_ref().map(|name| name.to_string()), "visibility": field.vis.to_token_stream().to_string(), "line": field.ident.as_ref().map(|name| name.span().start().line).unwrap_or(field.span().start().line)})).collect()
            } else { Vec::new() };
            let body = if let Item::Fn(value) = item { Some(value.block.to_token_stream().to_string()) } else { None };
            json!({"kind": kind, "name": name, "visibility": visibility, "refs": refs, "bindings": bindings, "members": members, "fields": fields, "body": body,
                "start": item.span().start().line, "end": item.span().end().line})
        }).collect();
        reports.push(json!({"file": file, "items": items}));
    }
    println!("{}", serde_json::to_string(&reports).unwrap());
}
