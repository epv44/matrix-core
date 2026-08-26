# Python Anti-Pattern Rules Checklist

Use this checklist selectively when the changed code contains the relevant construct. Report only a concrete defect whose behavior or cost is established by the supplied repository evidence; do not report checklist wording or examples as findings.

---

## MANDATORY CHECKLIST

Apply only the sections relevant to the changed code and its evidenced execution path.

---

## 1. Data Structure Anti-Patterns

### 1.1 Repeated Membership Testing on Large Collections
Preserve a list when ordering, duplicates, indexing, or a small bounded collection is part of the behavior. Consider a set or dict only when membership is repeated or occurs on a demonstrated hot path and the collection is large enough for linear lookup to matter.

- [ ] Is a large list searched repeatedly in a loop or latency-sensitive path? → Consider a set or dict
- [ ] Would conversion change ordering, duplicate, mutation, or serialization semantics? → Keep the list or preserve those semantics explicitly
- [ ] Is `list.index()` or `list.count()` repeatedly called on a large collection? → Consider an indexed representation

**Example pattern to catch:**
```python
# Potential hot-path issue: O(n) lookup per check on a large collection
allowed_users = ["alice", "bob", "charlie", ...]  # 10,000 users
if username in allowed_users:  # O(n) linear scan every time
    grant_access()

#  CORRECT: O(1) lookup
allowed_users = {"alice", "bob", "charlie", ...}  # set
if username in allowed_users:  # O(1) hash lookup
    grant_access()
```

### 1.2 Mutable Default Arguments
**Check every function definition:**
- [ ] Does any parameter have a mutable default (`list`, `dict`, `set`)? → Use `None` and initialize inside
- [ ] Is the default argument a class instance? → Use `None`

**Example pattern to catch:**
```python
#  ANTI-PATTERN: Shared mutable default
def add_item(item: str, items: list[str] = []) -> list[str]:
    items.append(item)  # Mutates the shared default!
    return items

#  CORRECT:
def add_item(item: str, items: list[str] | None = None) -> list[str]:
    if items is None:
        items = []
    items.append(item)
    return items
```

### 1.3 List When Generator Suffices
**Check every list creation:**
- [ ] Is a list created only to iterate over it once? → Use a generator expression
- [ ] Is a list comprehension passed to `sum()`, `any()`, `all()`, `min()`, `max()`? → Use generator expression
- [ ] Is a large list created just to get its length? → Use `sum(1 for ...)`

**Example pattern to catch:**
```python
#  ANTI-PATTERN: Creates entire list in memory
total = sum([x * x for x in range(1_000_000)])  # Allocates 1M-element list

#  CORRECT: Generator expression, no intermediate list
total = sum(x * x for x in range(1_000_000))  # Lazy evaluation
```

### 1.4 Unnecessary List Copies
**Check every list operation:**
- [ ] Is `list(some_list)` or `some_list[:]` used unnecessarily? → Only copy if mutation is a concern
- [ ] Is `sorted()` used when `list.sort()` would work? → `sorted()` creates a new list
- [ ] Is slicing used when an iterator would suffice?

### 1.5 Wrong Container Type
**Check container choices:**
- [ ] Is `list` used for FIFO queue operations? → Use `collections.deque`
- [ ] Is `dict` used for ordered insertion when order is not needed? → Consider if a simpler structure works
- [ ] Are multiple lists used for parallel data? → Use a list of dataclasses/namedtuples
- [ ] Is a list of tuples used for key-value lookups? → Use a dict

### 1.6 Not Using defaultdict or Counter
**Check dict patterns:**
- [ ] Is `if key not in dict: dict[key] = []` pattern used? → Use `collections.defaultdict(list)`
- [ ] Is manual counting done in a loop? → Use `collections.Counter`
- [ ] Is `dict.setdefault()` used repeatedly? → Use `defaultdict`

---

## 2. String Anti-Patterns

### 2.1 String Concatenation in Loop
**Check every loop that builds a string:**
- [ ] Is `+=` used to concatenate strings in a loop? → Use `str.join()` or `list.append()` + `join()`
- [ ] Is string formatting (`f"..."` or `.format()`) used in a loop to build a large string? → Collect parts, join once

**Example pattern to catch:**
```python
#  ANTI-PATTERN: O(n²) string concatenation
result = ""
for item in items:
    result += f"{item.name}: {item.value}\n"  # Creates new string each iteration

#  CORRECT: O(n) with join
result = "\n".join(f"{item.name}: {item.value}" for item in items)
```

### 2.2 Regex Compilation in Loop
**Check every `re.match()`, `re.search()`, `re.sub()` call:**
- [ ] Is a regex pattern compiled inside a loop? → Compile once outside with `re.compile()`
- [ ] Is `re.match()` or `re.search()` called with a string pattern in a hot path? → Use `re.compile()`

**Example pattern to catch:**
```python
#  ANTI-PATTERN: Recompiles regex on every iteration
for line in lines:
    if re.match(r"\d{4}-\d{2}-\d{2}", line):  # Compiles pattern each time
        process(line)

#  CORRECT: Compile once
DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")
for line in lines:
    if DATE_PATTERN.match(line):
        process(line)
```

### 2.3 Unnecessary String Conversions
**Check every str() call:**
- [ ] Is `str()` called on a value that is already a string?
- [ ] Is f-string used where a simple variable reference works?
- [ ] Is `.format()` used when f-string is cleaner?

### 2.4 Using Regex for Simple String Operations
**Check regex usage:**
- [ ] Is `re.sub()` used for simple replacements? → Use `str.replace()`
- [ ] Is `re.split()` used for simple delimiter splits? → Use `str.split()`
- [ ] Is `re.match()` used for prefix checking? → Use `str.startswith()`
- [ ] Is `re.search()` used for substring checking? → Use `in` operator

---

## 3. Loop Anti-Patterns

### 3.1 Not Using Comprehensions
**Check every loop that builds a list, dict, or set:**
- [ ] Is a loop with `append()` used to build a list? → Use list comprehension
- [ ] Is a loop used to build a dict? → Use dict comprehension
- [ ] Is a loop used to build a set? → Use set comprehension
- [ ] Is the comprehension too complex (nested, multiple conditions)? → Keep the loop for readability

### 3.2 Calling len() or Function in Loop Condition
**Check loop conditions:**
- [ ] Is `len(collection)` called in a `while` condition that does not change size? → Cache it
- [ ] Is an expensive function called in a loop condition?
- [ ] Is `range(len(x))` used when `enumerate(x)` works? → Use `enumerate()`

### 3.3 Not Using enumerate
**Check every indexed loop:**
- [ ] Is `for i in range(len(items))` used? → Use `for i, item in enumerate(items)`
- [ ] Is a manual counter variable maintained? → Use `enumerate()`

### 3.4 Global Variable Access in Tight Loops
**Check tight loops:**
- [ ] Are global or module-level variables accessed repeatedly in a loop? → Cache in a local variable
- [ ] Are dotted attribute lookups done repeatedly? → Cache the attribute reference

**Example pattern to catch:**
```python
#  ANTI-PATTERN: Attribute lookup every iteration
for item in items:
    result.append(item)  # result.append is looked up each time

#  CORRECT: Cache the method reference
append = result.append
for item in items:
    append(item)
```

### 3.5 Appending in Loop vs Comprehension
**Check list building loops:**
- [ ] Is `list.append()` in a simple loop? → Use list comprehension (30-50% faster)
- [ ] Is `list.extend()` available instead of a loop of `append()`?

### 3.6 Not Breaking Early
**Check search loops:**
- [ ] Does a loop continue after finding its target? → Add `break`
- [ ] Can `any()` or `next()` replace the loop entirely?

---

## 4. Function Call Anti-Patterns

### 4.1 Attribute Lookup in Loops
**Check every method call in a loop:**
- [ ] Is `obj.method()` called in a tight loop? → Cache `method = obj.method` outside the loop
- [ ] Is `module.function()` called repeatedly? → Import directly or cache reference

### 4.2 Not Using Built-in Functions
**Check for manual implementations:**
- [ ] Is a manual sum loop used? → Use `sum()`
- [ ] Is a manual any/all check loop used? → Use `any()` / `all()`
- [ ] Is a manual min/max loop used? → Use `min()` / `max()`
- [ ] Is a manual map/filter loop used when it would be clearer? → Consider `map()` / `filter()`

### 4.3 Repeated Expensive Function Calls
**Check for duplicate calls:**
- [ ] Is the same function called multiple times with identical arguments? → Cache the result
- [ ] Is `len()` called on the same collection multiple times? → Cache in a variable
- [ ] Are expensive property accesses repeated? → Cache the value

### 4.4 Unnecessary Lambda
**Check every lambda:**
- [ ] Is `lambda x: func(x)` used? → Pass `func` directly
- [ ] Is `lambda x: x.attr` used? → Use `operator.attrgetter("attr")`
- [ ] Is a lambda used for a simple operation? → Use `functools.partial` or direct reference

---

## 5. Import and Module Anti-Patterns

### 5.1 Heavy Imports at Module Level
**Check import statements:**
-
 [ ] Are heavy/slow modules imported at module level when only used in 
rare code paths? → Move to function level or use lazy imports
- [ ] Is the entire module imported when only a small part is needed? → Import specific items
- [ ] Is `import *` used? → Import specific names

**Example pattern to catch:**
```python
#  ANTI-PATTERN: Heavy import always loaded
import pandas as pd  # 200ms+ import time, even if rarely used

def rare_function():
    return pd.DataFrame(...)

#  CORRECT: Import only when needed
def rare_function():
    import pandas as pd
    return pd.DataFrame(...)
```

### 5.2 Not Importing the Smallest Unit
**Check import granularity:**
- [ ] Is `import large_module` used when `from large_module.submodule import func` works? → Import the smallest unit needed

---

## 6. Memory Anti-Patterns

### 6.1 Not Using Generators for Large Datasets
**Check data processing functions:**
- [ ] Does a function build a large list and return it? → Use `yield` to make it a generator
- [ ] Is a file read entirely into memory? → Process line by line
- [ ] Is `readlines()` used for large files? → Iterate the file object directly

**Example pattern to catch:**
```python
#  ANTI-PATTERN: Loads entire file into memory
def get_lines(path: str) -> list[str]:
    with open(path) as f:
        return f.readlines()  # Entire file in memory

#  CORRECT: Generator, constant memory
def get_lines(path: str) -> Iterator[str]:
    with open(path) as f:
        for line in f:
            yield line.strip()
```

### 6.2 Not Using __slots__
**Check classes with many instances:**
- [ ] Is a class instantiated thousands+ of times? → Add `__slots__` for 30-50% memory reduction
- [ ] Is `@dataclass` used without `slots=True` (Python 3.10+)?

**Example pattern to catch:**
```python
#  ANTI-PATTERN: Each instance has a __dict__ (56+ bytes overhead)
class Point:
    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y

#  CORRECT: No __dict__, 30-50% less memory per instance
class Point:
    __slots__ = ("x", "y")
    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y

#  CORRECT: Dataclass with slots (Python 3.10+)
@dataclass(slots=True)
class Point:
    x: float
    y: float
```

### 6.3 Holding References to Large Objects
**Check variable lifetimes:**
- [ ] Are large objects kept alive longer than needed? → Delete or let go out of scope
- [ ] Are closures capturing large objects unintentionally?
- [ ] Are module-level caches unbounded? → Use `functools.lru_cache` with `maxsize`

### 6.4 Large List from Slicing
**Check slice operations:**
- [ ] Is a large list sliced when `itertools.islice()` would work? → Use `islice` for lazy slicing
- [ ] Is `list[:]` used to copy a large list unnecessarily?

---

## 7. I/O Anti-Patterns

### 7.1 Not Using Context Managers
**Check every file/resource open:**
- [ ] Is `open()` used without `with`? → Use `with` statement
- [ ] Are database connections/cursors not properly closed? → Use context managers
- [ ] Are network sockets not properly closed? → Use context managers

### 7.2 Reading Entire File When Line-by-Line Works
**Check file reading:**
- [ ] Is `f.read()` used when line-by-line processing works? → Iterate the file object
- [ ] Is `f.readlines()` used for large files? → Iterate directly
- [ ] Is `json.load()` used on a huge JSON file? → Consider streaming parser (e.g., `ijson`)

### 7.3 Synchronous I/O in Async Context
**Check async functions:**
- [ ] Is `open()` / `time.sleep()` / blocking I/O used in async code? → Use `aiofiles` / `asyncio.sleep()` / async I/O
- [ ] Is `requests` library used in async code? → Use `aiohttp` or `httpx`
- [ ] Is `time.sleep()` used in async code? → Use `await asyncio.sleep()`

**Example pattern to catch:**
```python
#  ANTI-PATTERN: Blocks the entire event loop
async def fetch_data():
    time.sleep(1)  # Blocks event loop!
    response = requests.get(url)  # Blocks event loop!
    return 
