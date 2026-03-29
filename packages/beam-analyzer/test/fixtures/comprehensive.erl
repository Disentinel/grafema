-module(comprehensive).
-export([start/0, handle_call/3, add/2, factorial/1]).
-import(lists, [map/2, filter/2]).

-type state() :: #{name := string(), count := integer()}.
-spec add(number(), number()) -> number().
-spec factorial(non_neg_integer()) -> pos_integer().

start() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

handle_call({get, Key}, _From, State) ->
    Value = maps:get(Key, State, undefined),
    {reply, Value, State};
handle_call({put, Key, Value}, _From, State) ->
    NewState = maps:put(Key, Value, State),
    {reply, ok, NewState}.

add(A, B) ->
    Result = A + B,
    io:format("~p + ~p = ~p~n", [A, B, Result]),
    Result.

factorial(0) -> 1;
factorial(N) when N > 0 ->
    N * factorial(N - 1).

internal_helper(Data) ->
    lists:map(fun(X) -> X * 2 end, Data).
