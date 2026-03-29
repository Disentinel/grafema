-module(sample_mod).
-export([hello/1, add/2]).

-type name() :: string().

-spec hello(name()) -> ok.
hello(Name) ->
    io:format("Hello ~s~n", [Name]),
    ok.

-spec add(number(), number()) -> number().
add(A, B) ->
    A + B.
